import test from 'node:test'
import assert from 'node:assert/strict'
import { createWxStore, type WxDatabase } from '../src/repositories/wx-store'
import { meta, stableId } from '../src/infrastructure/ids'

test('transaction-local repeated reads share one SDK read, isolate returned objects and observe writes', async () => {
  let reads = 0
  let failWrite = false
  const persisted = { ...meta('limit', 0), count: 1, windowStart: 0, requestKeys: [] }
  const database: WxDatabase = {
    command: { gt: (value) => value, lt: (value) => value, in: (values) => values },
    runTransaction: (operation) =>
      operation({
        collection: () => ({
          doc: (id) => ({
            get: async () => {
              reads++
              return { data: id === 'missing' ? null : { ...persisted } }
            },
            set: async () => {
              if (failWrite) throw new Error('write failed')
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
          get: async () => ({ data: [] }),
        }),
      }),
  }
  const store = createWxStore(database)
  await store.transaction(async (tx) => {
    const first = await tx.get('rate_limits', 'limit')
    assert.ok(first)
    first.count = 99
    assert.equal((await tx.get('rate_limits', 'limit'))?.count, 1)
    assert.equal(reads, 1, 'duplicate authorization reads must not call SDK again')
    await tx.set('rate_limits', { ...persisted, count: 2 })
    assert.equal((await tx.get('rate_limits', 'limit'))?.count, 2)
    failWrite = true
    await assert.rejects(tx.set('rate_limits', { ...persisted, count: 3 }), /write failed/)
    assert.equal((await tx.get('rate_limits', 'limit'))?.count, 2)
    assert.equal(await tx.get('rate_limits', 'missing'), null)
    assert.equal(await tx.get('rate_limits', 'missing'), null)
    assert.equal(reads, 2)
  })
  await store.transaction(async (tx) => {
    assert.equal((await tx.get('rate_limits', 'limit'))?.count, 1)
    assert.equal(reads, 3, 'new transaction must read a fresh snapshot')
  })
})

test('SDK transaction retry rebuilds its read cache instead of reusing the aborted snapshot', async () => {
  let attempt = 0
  let reads = 0
  const database: WxDatabase = {
    command: { gt: (value) => value, lt: (value) => value, in: (values) => values },
    async runTransaction(operation) {
      const native = {
        collection: () => ({
          doc: () => ({
            get: async () => {
              reads++
              return {
                data: { ...meta('limit', 0), count: attempt, windowStart: 0, requestKeys: [] },
              }
            },
            set: async () => {},
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
          get: async () => ({ data: [] }),
        }),
      }
      await operation(native)
      attempt++
      return operation(native)
    },
  }
  const counts: (number | undefined)[] = []
  await createWxStore(database).transaction(async (tx) => {
    counts.push((await tx.get('rate_limits', 'limit'))?.count)
    await tx.get('rate_limits', 'limit')
  })
  assert.deepEqual(counts, [0, 1])
  assert.equal(reads, 2)
})

test('SDK Adapter保留事务、空文档为null、写入移除_id且不吞掉数据库错误', async () => {
  const writes: { data: Record<string, unknown> }[] = []
  let retries: number | undefined
  let failing = false
  const database: WxDatabase = {
    command: {
      gt: (value) => ({ gt: value }),
      lt: (value) => ({ lt: value }),
      in: (values) => ({ in: values }),
    },
    async runTransaction(operation, retryCount) {
      retries = retryCount
      return operation({
        collection: () => ({
          doc: () => ({
            async get() {
              if (failing) throw new Error('database unavailable')
              return { data: null }
            },
            async set(options) {
              writes.push(options)
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
            return { data: [] }
          },
        }),
      })
    },
  }
  const store = createWxStore(database)
  const missing = await store.transaction((tx) => tx.get('rooms', 'missing'))
  assert.equal(missing, null)
  await store.transaction((tx) =>
    tx.set('rate_limits', { ...meta('lim_test', 100), count: 1, windowStart: 0, requestKeys: [] }),
  )
  assert.equal(retries, 3)
  assert.equal(Object.hasOwn(writes[0].data, '_id'), false)
  assert.equal(writes[0].data.count, 1)
  failing = true
  await assert.rejects(
    store.transaction((tx) => tx.get('rooms', 'any')),
    /database unavailable/,
  )
})

test('最近房间键集续页先取同时间后续ID，再取更早时间，不使用offset', async () => {
  const filters: Record<string, unknown>[] = []
  const limits: number[] = []
  const orders: [string, string][] = []
  const replies = [[{ _id: 'mem_c' }], [{ _id: 'mem_d' }, { _id: 'mem_e' }]]
  const database: WxDatabase = {
    command: {
      gt: (value) => ({ gt: value }),
      lt: (value) => ({ lt: value }),
      in: (values) => ({ in: values }),
    },
    runTransaction: (operation) =>
      operation({
        collection: () => ({
          doc: () => ({ get: async () => ({ data: null }), set: async () => undefined }),
          where(filter) {
            filters.push(filter)
            return this
          },
          orderBy(field, direction) {
            orders.push([field, direction])
            return this
          },
          limit(limit) {
            limits.push(limit)
            return this
          },
          async get() {
            return { data: replies.shift() ?? [] }
          },
        }),
      }),
  }
  const store = createWxStore(database)
  const rows = await store.transaction((tx) =>
    tx.listRecent('user_a', 3, { lastVisitedAt: 10, id: 'mem_b' }),
  )
  assert.deepEqual(
    rows.map((row) => row._id),
    ['mem_c', 'mem_d', 'mem_e'],
  )
  assert.deepEqual(filters, [
    { userId: 'user_a', status: 'active', lastVisitedAt: 10, _id: { gt: 'mem_b' } },
    { userId: 'user_a', status: 'active', lastVisitedAt: { lt: 10 } },
  ])
  assert.deepEqual(limits, [3, 2])
  assert.deepEqual(orders, [
    ['lastVisitedAt', 'desc'],
    ['_id', 'asc'],
    ['lastVisitedAt', 'desc'],
    ['_id', 'asc'],
  ])
})

test('点数批量读取只查询一次，使用事务集合、稳定ID的in条件及15条上限', async () => {
  const filters: Record<string, unknown>[] = []
  const limits: number[] = []
  let reads = 0
  const database: WxDatabase = {
    command: { gt: (value) => value, lt: (value) => value, in: (values) => ({ in: values }) },
    runTransaction: (operation) =>
      operation({
        collection(name) {
          assert.equal(name, 'activity_cards')
          return {
            doc() {
              throw new Error('must not read cards individually')
            },
            where(filter) {
              filters.push(filter)
              return this
            },
            orderBy() {
              throw new Error('sorting is validated in service')
            },
            limit(value) {
              limits.push(value)
              return this
            },
            async get() {
              reads++
              return { data: [] }
            },
          }
        },
      }),
  }
  assert.deepEqual(
    await createWxStore(database).transaction((tx) => tx.listPointCards('act_test')),
    [],
  )
  assert.equal(reads, 1)
  assert.deepEqual(filters, [
    {
      _id: {
        in: Array.from({ length: 15 }, (_, index) =>
          stableId('card', 'act_test', String(index + 1)),
        ),
      },
    },
  ])
  assert.deepEqual(limits, [15])
})
