import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWxStore,
  type WxDatabase,
  type WxStoreObservation,
} from '../src/repositories/wx-store'
import { profileDatabase, type DatabaseProfile } from '../src/infrastructure/database-profile'
import { meta } from '../src/infrastructure/ids'

function fixture() {
  let clock = 0
  let getFailure: Error | null = null
  let setFailure: Error | null = null
  let retry = false
  let commitFailure: Error | null = null
  const database: WxDatabase = {
    command: { gt: (value) => value, lt: (value) => value, in: (values) => values },
    async runTransaction(operation) {
      clock += 10
      const native = {
        collection: () => ({
          doc: () => ({
            async get() {
              clock += 5
              if (getFailure) throw getFailure
              return { data: null }
            },
            async set() {
              clock += 8
              if (setFailure) throw setFailure
            },
          }),
          where() {
            return this
          },
          orderBy() {
            return this
          },
          limit() {
            return this
          },
          async get() {
            clock += 4
            return { data: [] }
          },
        }),
      }
      if (retry) {
        try {
          await operation(native)
        } catch {}
        clock += 7
      }
      const result = await operation(native)
      clock += 20
      if (commitFailure) throw commitFailure
      return result
    },
  }
  return {
    database,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms
    },
    failGet(error: Error | null) {
      getFailure = error
    },
    failSet(error: Error | null) {
      setFailure = error
    },
    retry() {
      retry = true
    },
    failCommit(error: Error) {
      commitFailure = error
    },
  }
}

test('可控时钟计量实际SDK调用，缓存命中不算读，重试分别重建缓存并累计callback', async () => {
  const f = fixture()
  f.retry()
  const events: WxStoreObservation[] = []
  const store = createWxStore(f.database, (event) => events.push(event), f.now)
  await store.transaction(async (tx) => {
    await tx.get('rooms', 'private_id')
    await tx.get('rooms', 'private_id')
    await tx.set('rate_limits', {
      ...meta('private_limit', 0),
      count: 1,
      windowStart: 0,
      requestKeys: [],
    })
    await tx.get('rate_limits', 'private_limit')
    await tx.listPointCards('private_activity')
    await tx.listMembers('private_room', undefined, 20)
    await tx.listRecent('private_user', 20, { lastVisitedAt: 1, id: 'private_member' })
    f.advance(3)
  })
  const operations = events.filter((event) => event.kind === 'operation')
  assert.equal(operations.length, 12) // per attempt: get + set + four query calls
  assert.deepEqual(
    operations.filter((event) => event.operation === 'get').map((event) => event.durationMs),
    [5, 5],
  )
  assert.deepEqual(
    operations.filter((event) => event.operation === 'set').map((event) => event.durationMs),
    [8, 8],
  )
  assert.deepEqual(
    operations.filter((event) => event.operation === 'query').map((event) => event.durationMs),
    Array(8).fill(4),
  )
  assert.deepEqual(events.at(-1), {
    kind: 'transaction',
    wallMs: 101,
    callbackMs: 64,
    attempts: 2,
    success: true,
  })
  assert.equal(JSON.stringify(events).includes('private_'), false)
})

test('失败操作计数且不缓存，observer抛错不改变原成功/异常，提交失败计入wall', async () => {
  const f = fixture()
  const events: WxStoreObservation[] = []
  const readError = new Error('secret read error')
  f.failGet(readError)
  const store = createWxStore(
    f.database,
    (event) => {
      events.push(event)
      throw new Error('logger unavailable')
    },
    f.now,
  )
  await store.transaction(async (tx) => {
    await assert.rejects(tx.get('rooms', 'secret'), (error) => error === readError)
    f.failGet(null)
    assert.equal(await tx.get('rooms', 'secret'), null)
    assert.equal(await tx.get('rooms', 'secret'), null)
  })
  assert.deepEqual(events.slice(0, 2), [
    { kind: 'operation', collection: 'rooms', operation: 'get', durationMs: 5, success: false },
    { kind: 'operation', collection: 'rooms', operation: 'get', durationMs: 5, success: true },
  ])
  const writeError = new Error('secret write error')
  f.failSet(writeError)
  await assert.rejects(
    store.transaction((tx) =>
      tx.set('rate_limits', { ...meta('secret', 0), count: 0, windowStart: 0, requestKeys: [] }),
    ),
    (error) => error === writeError,
  )
  assert.deepEqual(events.at(-2), {
    kind: 'operation',
    collection: 'rate_limits',
    operation: 'set',
    durationMs: 8,
    success: false,
  })
  assert.deepEqual(events.at(-1), {
    kind: 'transaction',
    wallMs: 18,
    callbackMs: 8,
    attempts: 1,
    success: false,
  })
  f.failSet(null)
  const commitError = new Error('secret commit error')
  f.failCommit(commitError)
  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.get('rooms', 'secret')
    }),
    (error) => error === commitError,
  )
  assert.deepEqual(events.at(-1), {
    kind: 'transaction',
    wallMs: 35,
    callbackMs: 5,
    attempts: 1,
    success: false,
  })
})

test('每请求一条db-profile，按集合/操作汇总并隔离并发请求，不泄露原始数据', async () => {
  const profiles: DatabaseProfile[] = []
  const run = profileDatabase(
    async (event, observer) => {
      const f = fixture()
      const store = createWxStore(f.database, observer, f.now)
      await store.transaction(async (tx) => {
        await tx.get('rooms', 'private_id')
        await tx.get('rooms', 'private_id')
      })
      if (event === null) throw new Error('secret failure')
      await store.transaction(async (tx) => {
        await tx.listPointCards('private_activity')
      })
      return 'unchanged'
    },
    new Set(['point.claim']),
    (profile) => {
      profiles.push(profile)
    },
  )
  assert.deepEqual(
    await Promise.all([
      run({ action: 'point.claim', payload: 'secret' }),
      run({ action: 'secret' }),
    ]),
    ['unchanged', 'unchanged'],
  )
  assert.equal(profiles.length, 2)
  for (const profile of profiles) {
    assert.deepEqual(profile.operations, [
      { collection: 'rooms', operation: 'get', count: 1, failures: 0, durationMs: 5 },
      { collection: 'activity_cards', operation: 'query', count: 1, failures: 0, durationMs: 4 },
    ])
    assert.deepEqual(profile.transactions, {
      count: 2,
      failures: 0,
      wallMs: 69,
      callbackMs: 9,
      attempts: 2,
      beginCommitSdkMs: 60,
    })
  }
  assert.deepEqual(profiles.map((profile) => profile.action).sort(), ['invalid', 'point.claim'])
  await assert.rejects(run(null), /secret failure/)
  assert.equal(profiles.length, 3)
  assert.equal(profiles[2].transactions.count, 1)
  assert.equal(JSON.stringify(profiles).includes('secret'), false)
  assert.equal(JSON.stringify(profiles).includes('private_'), false)
  const loggingFailure = profileDatabase(
    async () => 42,
    new Set(),
    () => {
      throw new Error('logging error')
    },
  )
  assert.equal(await loggingFailure(null), 42)
})

test('失败callback重试也累计耗时；默认无observer不触发时钟或观测', async () => {
  const f = fixture()
  f.retry()
  const events: WxStoreObservation[] = []
  let attempts = 0
  const store = createWxStore(f.database, (event) => events.push(event), f.now)
  await store.transaction(async (tx) => {
    await tx.get('rooms', 'private')
    if (++attempts === 1) throw new Error('transient retry')
  })
  assert.deepEqual(events.at(-1), {
    kind: 'transaction',
    wallMs: 47,
    callbackMs: 10,
    attempts: 2,
    success: true,
  })
  const unobserved = createWxStore(fixture().database, undefined, () => {
    throw new Error('clock must be unused')
  })
  assert.equal(await unobserved.transaction((tx) => tx.get('rooms', 'private')), null)
})
