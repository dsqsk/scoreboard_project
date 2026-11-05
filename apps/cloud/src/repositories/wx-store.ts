import { stableId } from '../infrastructure/ids'
import type { Collections } from '../domain/models'
import type { Collection, Store, Transaction } from './store'

// wx-server-sdk 3.x runtime supports transactions, but its community types omit them.
// Keep the narrow runtime seam here rather than disabling type checks across business code.
interface WxQuery {
  where(filter: Record<string, unknown>): WxQuery
  orderBy(field: string, direction: 'asc' | 'desc'): WxQuery
  limit(limit: number): WxQuery
  get(): Promise<{ data: unknown }>
}
interface WxCollection extends WxQuery {
  doc(id: string): {
    get(): Promise<{ data: unknown }>
    set(options: { data: Record<string, unknown> }): Promise<unknown>
  }
}
interface WxTransaction {
  collection(name: string): WxCollection
}
export interface WxDatabase {
  runTransaction<T>(fn: (tx: WxTransaction) => Promise<T>, retries: number): Promise<T>
  command: { gt(value: string): unknown; lt(value: number): unknown; in(values: string[]): unknown }
}
export type WxStoreObservation =
  | {
      kind: 'operation'
      collection: Collection
      operation: 'get' | 'set' | 'query'
      durationMs: number
      success: boolean
    }
  | { kind: 'transaction'; wallMs: number; callbackMs: number; attempts: number; success: boolean }
export type WxStoreObserver = (event: WxStoreObservation) => void

export function createWxStore(
  database: WxDatabase,
  observer?: WxStoreObserver,
  now: () => number = () => performance.now(),
): Store {
  const emit = (event: WxStoreObservation) => {
    try {
      observer?.(event)
    } catch {}
  }
  async function measure<T>(
    collection: Collection,
    operation: 'get' | 'set' | 'query',
    run: () => Promise<T>,
  ): Promise<T> {
    if (!observer) return run()
    const start = now()
    let success = false
    try {
      const result = await run()
      success = true
      return result
    } finally {
      emit({
        kind: 'operation',
        collection,
        operation,
        durationMs: Math.max(0, now() - start),
        success,
      })
    }
  }
  return {
    transaction: async (operation) => {
      const start = observer ? now() : 0
      let callbackMs = 0
      let attempts = 0
      let success = false
      try {
        const result = await database.runTransaction(async (native) => {
          attempts++
          const callbackStart = observer ? now() : 0
          try {
            // The callback is recreated for each retry: never share authorization reads
            // across transactions. Clone at the seam so callers cannot mutate this snapshot.
            const documents = new Map<string, Collections[Collection] | null>()
            const cacheKey = (collection: Collection, id: string) =>
              JSON.stringify([collection, id])
            const tx: Transaction = {
              async listPointCards(activityId) {
                // Reuse the existing _id index; match exactly the original fifteen document reads.
                const ids = Array.from({ length: 15 }, (_, index) =>
                  stableId('card', activityId, String(index + 1)),
                )
                const { data } = await measure('activity_cards', 'query', () =>
                  native
                    .collection('activity_cards')
                    .where({ _id: database.command.in(ids) })
                    .limit(15)
                    .get(),
                )
                return data as Collections['activity_cards'][]
              },
              async get<K extends Collection>(collection: K, id: string) {
                const key = cacheKey(collection, id)
                if (documents.has(key))
                  return structuredClone(documents.get(key)) as Collections[K] | null
                // database({throwOnNotFound:false}) makes missing documents null, not ambiguous exceptions.
                const { data } = await measure(collection, 'get', () =>
                  native.collection(collection).doc(id).get(),
                )
                const document = (data ?? null) as Collections[K] | null
                documents.set(key, structuredClone(document))
                return document
              },
              async set(collection, document) {
                const { _id, ...data } = document
                await measure(collection, 'set', () =>
                  native.collection(collection).doc(_id).set({ data }),
                )
                documents.set(cacheKey(collection, _id), structuredClone(document))
              },
              async listRecent(userId, limit, after) {
                const base = { userId, status: 'active' }
                const query = async (filter: Record<string, unknown>, count: number) => {
                  const { data } = await measure('room_members', 'query', () =>
                    native
                      .collection('room_members')
                      .where(filter)
                      .orderBy('lastVisitedAt', 'desc')
                      .orderBy('_id', 'asc')
                      .limit(count)
                      .get(),
                  )
                  return data as Collections['room_members'][]
                }
                if (!after) return query(base, limit)
                // Split lexicographic continuation into two indexed ranges, without offset/skip.
                const tied = await query(
                  {
                    ...base,
                    lastVisitedAt: after.lastVisitedAt,
                    _id: database.command.gt(after.id),
                  },
                  limit,
                )
                if (tied.length === limit) return tied
                return [
                  ...tied,
                  ...(await query(
                    { ...base, lastVisitedAt: database.command.lt(after.lastVisitedAt) },
                    limit - tied.length,
                  )),
                ]
              },
              async listMembers(roomId, after, limit) {
                const filter: Record<string, unknown> = { roomId, status: 'active' }
                if (after) filter._id = database.command.gt(after)
                const { data } = await measure('room_members', 'query', () =>
                  native
                    .collection('room_members')
                    .where(filter)
                    .orderBy('_id', 'asc')
                    .limit(limit)
                    .get(),
                )
                return data as Collections['room_members'][]
              },
            }
            return await operation(tx)
          } finally {
            if (observer) callbackMs += Math.max(0, now() - callbackStart)
          }
        }, 3)
        success = true
        return result
      } finally {
        if (observer)
          emit({
            kind: 'transaction',
            wallMs: Math.max(0, now() - start),
            callbackMs,
            attempts,
            success,
          })
      }
    },
  }
}
