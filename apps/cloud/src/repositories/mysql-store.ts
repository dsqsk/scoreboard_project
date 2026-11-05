import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { Collections, Activity, PointCard, ActivityScore } from '../domain/models'
import type { Collection, Store, Transaction } from './store'
import { table } from './mysql-schema'

export interface SqlConnection {
  execute(sql: string, values?: unknown[]): Promise<[unknown, unknown]>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
}
export interface SqlPool {
  getConnection(): Promise<SqlConnection>
  end(): Promise<void>
}
export function createMysqlPool(config: {
  host: string
  port: number
  user: string
  password: string
  database: string
}): SqlPool {
  const require = createRequire(resolve(process.cwd(), 'package.json'))
  const driver = require('mysql2/promise') as { createPool(config: object): SqlPool }
  return driver.createPool({
    ...config,
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 50,
    connectTimeout: 5000,
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  })
}
export async function rows<T>(
  connection: SqlConnection,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const [result] = await connection.execute(sql, values)
  if (!Array.isArray(result)) throw new Error('Expected SQL rows')
  return result as T[]
}
export function decode<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}
export interface MysqlStore extends Store {
  request<T>(operation: () => Promise<T>): Promise<T>
}
export function createMysqlStore(pool: SqlPool): MysqlStore {
  const context = new AsyncLocalStorage<Transaction>()
  async function transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    const active = context.getStore()
    if (active) return operation(active)
    for (let attempt = 0; ; attempt++) {
      const connection = await pool.getConnection()
      try {
        await connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        await connection.beginTransaction()
        const cache = new Map<string, Collections[Collection] | null>()
        const pending = new Map<Collection, Map<string, Collections[Collection]>>()
        const hotCards = new Map<string, PointCard[]>()
        const key = (collection: Collection, id: string) => `${collection}/${id}`
        const tx: Transaction = {
          async get<K extends Collection>(collection: K, id: string) {
            const k = key(collection, id)
            if (cache.has(k)) return structuredClone(cache.get(k)) as Collections[K] | null
            const found = await rows<{ doc: unknown }>(
              connection,
              `SELECT doc FROM ${table(collection)} WHERE id=? FOR UPDATE`,
              [id],
            )
            const doc = found.length ? decode<Collections[K]>(found[0].doc) : null
            cache.set(k, doc)
            return structuredClone(doc)
          },
          async set(collection, document) {
            if (!pending.has(collection)) pending.set(collection, new Map())
            const copy = structuredClone(document)
            pending.get(collection)!.set(document._id, copy)
            cache.set(key(collection, document._id), copy)
            if (collection === 'activity_cards') {
              const card = copy as PointCard
              const cards = hotCards.get(card.activityId)
              if (cards) {
                const i = cards.findIndex((item) => item._id === card._id)
                if (i >= 0) cards[i] = card
                else cards.push(card)
              }
            }
          },
          async listPointCards(activityId) {
            if (!hotCards.has(activityId)) {
              const hot = await rows<{ cards: unknown }>(
                connection,
                'SELECT cards FROM sb_activity_hot WHERE id=? FOR UPDATE',
                [activityId],
              )
              if (!hot.length) throw new Error('Activity hot state missing; migration incomplete')
              hotCards.set(activityId, decode<PointCard[]>(hot[0].cards))
            }
            return structuredClone(hotCards.get(activityId)!)
          },
          async listMembers(roomId, after, limit) {
            const found = await rows<{ doc: unknown }>(
              connection,
              `SELECT doc FROM sb_room_members WHERE room_id=? AND status='active' ${after ? 'AND id>?' : ''} ORDER BY id ASC LIMIT ? FOR UPDATE`,
              after ? [roomId, after, limit] : [roomId, limit],
            )
            return found.map((row) => decode<Collections['room_members']>(row.doc))
          },
          async listRecent(userId, limit, after) {
            const found = await rows<{ doc: unknown }>(
              connection,
              `SELECT doc FROM sb_room_members WHERE user_id=? AND status='active' ${after ? 'AND (visited<? OR (visited=? AND id>?))' : ''} ORDER BY visited DESC,id ASC LIMIT ? FOR UPDATE`,
              after
                ? [userId, after.lastVisitedAt, after.lastVisitedAt, after.id, limit]
                : [userId, limit],
            )
            return found.map((row) => decode<Collections['room_members']>(row.doc))
          },
        }
        const result = await context.run(tx, () => operation(tx))
        // Batch canonical writes by table instead of one SQL round trip per document.
        for (const [collection, documents] of pending) {
          const list = [...documents.values()]
          await connection.execute(
            `INSERT INTO ${table(collection)} (id,doc) VALUES ${list.map(() => '(?,?)').join(',')} ON DUPLICATE KEY UPDATE doc=VALUES(doc)`,
            list.flatMap((doc) => [doc._id, JSON.stringify(doc)]),
          )
        }
        const changed = new Set<string>()
        for (const collection of ['activities', 'activity_cards', 'activity_scores'] as const)
          for (const doc of pending.get(collection)?.values() ?? [])
            changed.add(
              collection === 'activities' ? doc._id : (doc as PointCard | ActivityScore).activityId,
            )
        for (const id of changed) {
          const activityRows = await rows<{ doc: unknown }>(
            connection,
            'SELECT doc FROM sb_activities WHERE id=? FOR UPDATE',
            [id],
          )
          if (!activityRows.length) throw new Error('Activity missing')
          const cardRows = hotCards.has(id)
            ? hotCards.get(id)!
            : (
                await rows<{ doc: unknown }>(
                  connection,
                  'SELECT doc FROM sb_activity_cards WHERE activity_id=? ORDER BY number_value FOR UPDATE',
                  [id],
                )
              ).map((row) => decode<PointCard>(row.doc))
          const scores = (
            await rows<{ doc: unknown }>(
              connection,
              'SELECT doc FROM sb_activity_scores WHERE activity_id=? FOR UPDATE',
              [id],
            )
          ).map((row) => decode<ActivityScore>(row.doc))
          await connection.execute(
            'INSERT INTO sb_activity_hot(id,activity,cards,scores) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE activity=VALUES(activity),cards=VALUES(cards),scores=VALUES(scores)',
            [
              id,
              JSON.stringify(decode<Activity>(activityRows[0].doc)),
              JSON.stringify(cardRows),
              JSON.stringify(scores),
            ],
          )
        }
        await connection.commit()
        return result
      } catch (error) {
        try {
          await connection.rollback()
        } catch {}
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null
        if (attempt < 2 && (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT'))
          continue
        throw error
      } finally {
        connection.release()
      }
    }
  }
  return { transaction, request: (operation) => transaction(() => operation()) }
}
