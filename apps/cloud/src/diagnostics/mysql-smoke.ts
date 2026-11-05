import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  foundationRequestSchema,
  type CommandReceipt,
  type PointSnapshot,
  type FoundationRoomSnapshot,
  type ApiResult,
  type FoundationResponse,
} from '@scoreboard/shared'
import { createMysqlPool, createMysqlStore, rows, decode } from '../repositories/mysql-store'
import { COLLECTIONS, table } from '../repositories/mysql-schema'
import { createFoundation } from '../services/foundation'
import { defineHandler } from '../infrastructure/handler'
import { canonicalHash } from '../infrastructure/ids'
import type { Collection, Store } from '../repositories/store'

async function main() {
  if (
    !process.env.DB_NAME ||
    !/(?:rehearsal|staging|test)(?:_|$)/.test(process.env.DB_NAME) ||
    process.env.MYSQL_SMOKE_ALLOW !== 'true' ||
    process.env.WRITE_ENABLED === 'true'
  )
    throw new Error('Smoke requires isolated database, writes disabled and MYSQL_SMOKE_ALLOW=true')
  const pool = createMysqlPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? '',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME,
  })
  const sql = await pool.getConnection(),
    base = createMysqlStore(pool)
  const touched = new Map<Collection, Set<string>>()
  const store: Store = {
    transaction: (operation) =>
      base.transaction((tx) =>
        operation({
          ...tx,
          set: async (collection, doc) => {
            if (!touched.has(collection)) touched.set(collection, new Set())
            touched.get(collection)!.add(doc._id)
            await tx.set(collection, doc)
          },
        }),
      ),
  }
  const foundation = createFoundation({ store }),
    appId = `smoke_${randomUUID()}`
  let serial = 0
  const call = (
    who: string,
    action: string,
    payload: object,
    requestId = `smoke_${++serial}_${randomUUID()}`,
  ) =>
    defineHandler(foundationRequestSchema, (request) =>
      base.request(() => foundation.dispatch(request, { appId, openId: who })),
    )({ action, payload, requestId })
  const read = (who: string, action: string, payload: object) =>
    defineHandler(foundationRequestSchema, (request) =>
      base.request(() => foundation.dispatch(request, { appId, openId: who })),
    )({ action, payload })
  const unwrap = <T>(result: ApiResult<FoundationResponse>): T => {
    if (!result.ok) throw new Error(`Smoke API failure ${result.error.code}`)
    return result.data as T
  }
  const baseline = new Map<string, string>()
  for (const name of COLLECTIONS)
    for (const row of await rows<{ id: string; doc: unknown }>(
      sql,
      `SELECT id,doc FROM ${table(name)}`,
    ))
      baseline.set(`${name}/${row.id}`, canonicalHash(decode(row.doc)))
  try {
    const userA = unwrap<{ userId: string }>(await read('A', 'identity.getMe', {})),
      userB = unwrap<{ userId: string }>(await read('B', 'identity.getMe', {}))
    const room = unwrap<CommandReceipt>(await call('A', 'room.create', { mode: 'point_ball' })),
      roomId = room.roomId!
    unwrap(await call('B', 'room.join', { joinCode: room.joinCode }))
    const snapshot = unwrap<FoundationRoomSnapshot>(await read('A', 'room.getSnapshot', { roomId }))
    const prepared = unwrap<CommandReceipt>(
        await call('A', 'activity.prepare', {
          roomId,
          expectedRoomRevision: snapshot.roomRevision,
          participantIds: [userA.userId, userB.userId],
        }),
      ),
      activityId = prepared.activityId!
    const id = `smoke_once_${randomUUID()}`,
      payload = { roomId, activityId, number: 1, expectedCardRevision: 0 }
    const first = await call('A', 'point.claim', payload, id)
    assert.deepEqual(await call('A', 'point.claim', payload, id), first)
    assert.equal(unwrap<CommandReceipt>(first).pointState!.earnedPoints[userA.userId], 1)
    const mismatch = await call('A', 'point.claim', { ...payload, number: 2 }, id)
    assert.equal(!mismatch.ok && mismatch.error.code, 'IDEMPOTENCY_MISMATCH')
    const race = await Promise.all([
      call('A', 'point.claim', { ...payload, number: 2 }),
      call('B', 'point.claim', { ...payload, number: 2 }),
    ])
    assert.equal(race.filter((r) => r.ok).length, 1)
    assert.equal(race.filter((r) => !r.ok && r.error.code === 'CONFLICT').length, 1)
    const before = unwrap<PointSnapshot>(await read('A', 'point.getState', { roomId }))
    await assert.rejects(
      base.request(async () => {
        unwrap(await call('A', 'point.claim', { ...payload, number: 3 }))
        throw new Error('expected rollback')
      }),
      /expected rollback/,
    )
    assert.deepEqual(unwrap<PointSnapshot>(await read('A', 'point.getState', { roomId })), before)
    unwrap(await call('A', 'point.claim', { ...payload, number: 3 }))
    for (let number = 4; number <= 15; number++)
      unwrap(await call('A', 'point.claim', { ...payload, number }))
    const state = unwrap<PointSnapshot>(await read('A', 'point.getState', { roomId }))
    unwrap(
      await call('A', 'point.post', {
        roomId,
        activityId,
        expectedActivityRevision: state.activity!.revision,
      }),
    )
    const posted = unwrap<PointSnapshot>(await read('A', 'point.getState', { roomId }))
    assert.equal(posted.activity!.status, 'posted')
    assert.equal(
      Object.values(posted.totals).reduce((a, b) => a + b, 0),
      0,
    )
    for (const name of COLLECTIONS)
      for (const row of await rows<{ id: string; doc: unknown }>(
        sql,
        `SELECT id,doc FROM ${table(name)}`,
      ))
        if (baseline.has(`${name}/${row.id}`))
          assert.equal(
            canonicalHash(decode(row.doc)),
            baseline.get(`${name}/${row.id}`),
            'Imported data changed',
          )
    console.info(
      JSON.stringify({
        ok: true,
        tests: [
          'prepare',
          'claim',
          'receipt-replay',
          'payload-mismatch',
          'same-card-race',
          'transaction-rollback',
          'post',
          'imported-data-unchanged',
        ],
      }),
    )
  } finally {
    await cleanup()
  }
  async function cleanup() {
    await sql.beginTransaction()
    try {
      for (const [name, ids] of touched)
        for (const id of ids) {
          if (baseline.has(`${name}/${id}`)) throw new Error('Refuse cleanup of imported record')
          await sql.execute(`DELETE FROM ${table(name)} WHERE id=?`, [id])
          if (name === 'activities')
            await sql.execute('DELETE FROM sb_activity_hot WHERE id=?', [id])
        }
      await sql.commit()
    } catch (error) {
      await sql.rollback()
      throw error
    } finally {
      sql.release()
      await pool.end()
    }
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      stage: 'mysql-smoke',
      code:
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'SMOKE_FAILED',
    }),
  )
  process.exitCode = 1
})
