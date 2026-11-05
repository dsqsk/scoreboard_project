import { RoomApiError } from '../modules/room-api/errors'
import type { CommandReceipt } from '@scoreboard/shared'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockRoomApi } from '../modules/room-api/mock'
import { createMockPointApi } from '../features/point/api'
import type { PointCommand, PointSnapshot } from '../features/point/api'
import { createPointStore } from '../features/point/store'
import type { PointOperation } from '../features/point/store'
import { createCloudPointApi, isPointSnapshot } from '../features/point/cloud'

async function setup(
  count = 3,
  now = (() => {
    let time = 0
    return () => (time += 400)
  })(),
) {
  let rooms: unknown
  const base = createMockRoomApi({
    storage: {
      read: () => rooms,
      write: (value) => {
        rooms = structuredClone(value)
      },
    },
    delayMs: 0,
  })
  const receipt = await base.joinRoom('628388', 'join-point')
  let actor = 'mock-me'
  let late = false
  const roomApi = {
    ...base,
    async getMe() {
      return { userId: actor, displayName: actor === 'mock-me' ? '我' : actor }
    },
    async getRoomSnapshot(id: string) {
      const room = await base.getRoomSnapshot(id)
      return late
        ? {
            ...room,
            revision: room.revision + 1,
            memberCount: 4,
            members: [
              ...room.members,
              { userId: 'late-member', displayName: '新朋友', joinedAt: new Date().toISOString() },
            ],
          }
        : room
    },
  }
  let data: unknown
  let failWrite = false
  const storage = {
    read: () => structuredClone(data),
    write(value: unknown) {
      if (failWrite) throw new Error('disk failed')
      data = structuredClone(value)
    },
  }
  const api = createMockPointApi(roomApi, storage)
  const roomId = receipt.roomId
  const ids = ['mock-me', 'mock-point-0', 'mock-point-1'].slice(0, count)
  let serial = 0
  const requestId = () => `point-request-${++serial}`
  const prepare = () =>
    api
      .get(roomId)
      .then((snapshot) =>
        api.execute(
          roomId,
          { kind: 'prepare', expectedRoomRevision: snapshot.roomRevision, participantIds: ids },
          requestId(),
        ),
      )
  await prepare()
  let pending: PointOperation[] = []
  const journal = {
    read: () => structuredClone(pending),
    write(_userId: string, value: PointOperation[]) {
      pending = structuredClone(value)
    },
  }
  const session = createPointStore(api, requestId, journal, now)
  await session.open(roomId, 'mock-me')
  async function claim(number: number) {
    const activity = (await api.get(roomId)).activity!
    await api.execute(
      roomId,
      {
        kind: 'claim',
        activityId: activity.activityId,
        number,
        expectedCardRevision: activity.cards[number - 1]!.revision,
      },
      requestId(),
    )
  }
  async function correct(number: number, ownerUserId: string | null) {
    const a = (await api.get(roomId)).activity!
    await api.execute(
      roomId,
      {
        kind: 'correct',
        activityId: a.activityId,
        number,
        expectedCardRevision: a.cards[number - 1]!.revision,
        ownerUserId,
      },
      requestId(),
    )
  }
  return {
    api,
    base,
    roomApi,
    roomId,
    ids,
    storage,
    session,
    journal,
    requestId,
    prepare,
    claim,
    correct,
    act(id: string) {
      actor = id
    },
    late() {
      late = true
    },
    fail(value: boolean) {
      failWrite = value
    },
  }
}

test('point starts with 15 unique unowned cards and fixed three-player baseline, restores without reset', async () => {
  const { api, roomId, roomApi, storage, ids, prepare } = await setup()
  const snapshot = await api.get(roomId)
  assert.deepEqual(
    snapshot.activity!.cards.map((c) => c.number),
    Array.from({ length: 15 }, (_, i) => i + 1),
  )
  assert.ok(snapshot.activity!.cards.every((c) => c.ownerUserId === null))
  assert.deepEqual(snapshot.activity!.earnedPoints, Object.fromEntries(ids.map((id) => [id, 0])))
  assert.deepEqual(await createMockPointApi(roomApi, storage).get(roomId), snapshot)
  await assert.rejects(prepare(), { code: 'CONFLICT' })
})

test('claim and correction update progress only; immutable original recorder and change trail survive return/reclaim', async () => {
  const { api, roomId, claim, correct, ids, act } = await setup()
  await claim(6)
  act(ids[1]!)
  await claim(9)
  let s = await api.get(roomId)
  assert.deepEqual(s.activity!.earnedPoints, { [ids[0]!]: 6, [ids[1]!]: 9, [ids[2]!]: 0 })
  assert.ok(Object.values(s.totals).every((n) => n === 0))
  await correct(6, ids[1]!)
  s = await api.get(roomId)
  assert.equal(s.activity!.earnedPoints[ids[0]!], 0)
  assert.equal(s.activity!.earnedPoints[ids[1]!], 15)
  assert.equal(s.activity!.cards[5]!.lastModifiedBy, ids[1])
  await correct(6, null)
  await claim(6)
  s = await api.get(roomId)
  assert.equal(s.activity!.cards[5]!.initialRecordedBy, ids[0])
  assert.equal(s.activity!.cards[5]!.ownerUserId, ids[1])
  assert.equal(s.activity!.changes.length, 5)
})

test('same-card race has one winner; different cards use their own revision; duplicate ID is idempotent', async () => {
  const { api, roomId, ids, act, requestId } = await setup()
  const a = (await api.get(roomId)).activity!
  const command: PointCommand = {
    kind: 'claim',
    activityId: a.activityId,
    number: 6,
    expectedCardRevision: 0,
  }
  const firstId = requestId()
  const first = api.execute(roomId, command, firstId)
  act(ids[1]!)
  const second = api.execute(roomId, command, requestId())
  const results = await Promise.allSettled([first, second])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal((await api.get(roomId)).activity!.earnedPoints[ids[0]!], 6)
  act(ids[0]!)
  await api.execute(roomId, command, firstId)
  await Promise.all(
    [1, 2].map((number) => api.execute(roomId, { ...command, number }, requestId())),
  )
  assert.equal((await api.get(roomId)).activity!.earnedPoints[ids[0]!], 9)
  await assert.rejects(api.execute(roomId, { ...command, number: 3 }, firstId), {
    code: 'IDEMPOTENCY_MISMATCH',
  })
})

test('late room member cannot claim/post but may correct to original participants; roster stays fixed', async () => {
  const { api, roomId, ids, act, claim, correct, late, requestId } = await setup()
  await claim(6)
  late()
  act('late-member')
  const a = (await api.get(roomId)).activity!
  assert.deepEqual(
    a.participants.map((p) => p.userId),
    ids,
  )
  await assert.rejects(claim(9), { code: 'FORBIDDEN' })
  await assert.rejects(
    api.execute(
      roomId,
      { kind: 'post', activityId: a.activityId, expectedActivityRevision: a.revision },
      requestId(),
    ),
    { code: 'FORBIDDEN' },
  )
  await correct(6, ids[1]!)
  assert.equal((await api.get(roomId)).activity!.earnedPoints[ids[1]!], 6)
  await assert.rejects(correct(6, 'late-member'), { code: 'INVALID_ARGUMENT' })
})

async function fillBalanced(f: Awaited<ReturnType<typeof setup>>) {
  const sets = [
    [15, 14, 13, 12, 6],
    [11, 10, 9, 8, 2],
    [1, 3, 4, 5, 7],
  ]
  for (let i = 0; i < sets.length; i++) {
    f.act(f.ids[i]!)
    for (const number of sets[i]!) await f.claim(number)
  }
  f.act(f.ids[0]!)
}

test('incomplete post fails; complete 60/40/20 posts once as +20/0/-20; new game preserves cumulative and rejects old writes', async () => {
  const f = await setup()
  let a = (await f.api.get(f.roomId)).activity!
  await assert.rejects(
    f.api.execute(
      f.roomId,
      { kind: 'post', activityId: a.activityId, expectedActivityRevision: a.revision },
      f.requestId(),
    ),
    { code: 'INVALID_ARGUMENT' },
  )
  await fillBalanced(f)
  a = (await f.api.get(f.roomId)).activity!
  const command: PointCommand = {
    kind: 'post',
    activityId: a.activityId,
    expectedActivityRevision: a.revision,
  }
  const id = f.requestId()
  await f.api.execute(f.roomId, command, id)
  await f.api.execute(f.roomId, command, id)
  let snapshot = await f.api.get(f.roomId)
  assert.deepEqual(snapshot.totals, { [f.ids[0]!]: 20, [f.ids[1]!]: 0, [f.ids[2]!]: -20 })
  assert.equal(snapshot.results.length, 1)
  await assert.rejects(f.api.execute(f.roomId, command, f.requestId()), { code: 'ALREADY_POSTED' })
  await assert.rejects(f.correct(6, null), { code: 'ALREADY_POSTED' })
  await f.prepare()
  snapshot = await f.api.get(f.roomId)
  assert.notEqual(snapshot.activity!.activityId, a.activityId)
  assert.ok(snapshot.activity!.cards.every((c) => c.ownerUserId === null))
  assert.equal(snapshot.totals[f.ids[0]!], 20)
  await f.api.execute(f.roomId, command, id)
  assert.equal((await f.api.get(f.roomId)).activity!.revision, 0)
  await assert.rejects(
    f.api.execute(
      f.roomId,
      { kind: 'claim', activityId: a.activityId, number: 1, expectedCardRevision: 0 },
      f.requestId(),
    ),
    { code: 'STALE_CONTEXT' },
  )
})

test('post and correction use one consistent revision; stale preview cannot settle', async () => {
  const f = await setup()
  await fillBalanced(f)
  const a = (await f.api.get(f.roomId)).activity!
  await f.correct(6, f.ids[1]!)
  await assert.rejects(
    f.api.execute(
      f.roomId,
      { kind: 'post', activityId: a.activityId, expectedActivityRevision: a.revision },
      f.requestId(),
    ),
    { code: 'CONFLICT' },
  )
  assert.equal((await f.api.get(f.roomId)).results.length, 0)
  const current = (await f.api.get(f.roomId)).activity!
  await f.api.execute(
    f.roomId,
    { kind: 'post', activityId: current.activityId, expectedActivityRevision: current.revision },
    f.requestId(),
  )
  await assert.rejects(f.correct(6, f.ids[0]!), { code: 'ALREADY_POSTED' })
})

test('failed durable write cannot change card, earned score or audit trail', async () => {
  const f = await setup()
  const before = await f.api.get(f.roomId)
  f.fail(true)
  await assert.rejects(f.claim(6))
  assert.deepEqual(await f.api.get(f.roomId), before)
})

test('store prevents duplicate same-card writes but accepts different cards independently', async () => {
  const f = await setup()
  const a = f.session.store.getState().snapshot!.activity!
  const command: PointCommand = {
    kind: 'claim',
    activityId: a.activityId,
    number: 6,
    expectedCardRevision: 0,
  }
  const first = f.session.submit(command)
  assert.equal(await f.session.submit(command), false)
  const other = f.session.submit({ ...command, number: 9 })
  assert.equal(f.session.store.getState().requests.length, 2)
  await Promise.all([first, other])
  assert.equal(f.session.store.getState().snapshot!.activity!.earnedPoints[f.ids[0]!], 15)
  assert.equal(f.session.store.getState().requests.length, 0)
})

test('unknown response keeps exact ID on reload and blocks unrelated writes until confirmed', async () => {
  const f = await setup()
  const a = f.session.store.getState().snapshot!.activity!
  f.api.loseNextResponse()
  const command: PointCommand = {
    kind: 'claim',
    activityId: a.activityId,
    number: 6,
    expectedCardRevision: 0,
  }
  assert.equal(await f.session.submit(command), false)
  const pending = f.session.store.getState().requests[0]!
  assert.equal(f.session.store.getState().snapshot!.activity!.earnedPoints[f.ids[0]!], 0)
  assert.equal(await f.session.submit({ ...command, number: 9 }), false)
  const reload = createPointStore(f.api, () => 'must-not-use', f.journal)
  await reload.open(f.roomId, f.ids[0]!)
  assert.equal(reload.store.getState().requests[0]!.requestId, pending.requestId)
  await reload.recover()
  assert.equal(reload.store.getState().snapshot!.activity!.earnedPoints[f.ids[0]!], 6)
  assert.equal(reload.store.getState().snapshot!.activity!.changes.length, 1)
  assert.equal(reload.store.getState().requests.length, 0)
})

test('local journal failure sends no write; offline mode never auto-submits', async () => {
  const f = await setup()
  const session = createPointStore(f.api, f.requestId, {
    read: () => [],
    write() {
      throw new Error('journal failed')
    },
  })
  await session.open(f.roomId, f.ids[0]!)
  const a = session.store.getState().snapshot!.activity!
  const command: PointCommand = {
    kind: 'claim',
    activityId: a.activityId,
    number: 6,
    expectedCardRevision: 0,
  }
  assert.equal(await session.submit(command), false)
  assert.equal((await f.api.get(f.roomId)).activity!.revision, 0)
  session.setOnline(false)
  assert.equal(await session.submit(command), false)
  session.setOnline(true)
  assert.equal((await f.api.get(f.roomId)).activity!.revision, 0)
})

test('change pagination follows stable anchors and retains all audit entries across new changes', async () => {
  const f = await setup()
  for (let i = 0; i < 13; i++) {
    await f.claim(1)
    await f.correct(1, null)
  }
  const first = await f.api.get(f.roomId)
  assert.equal(first.activity!.changes.length, 20)
  assert.ok(first.nextChangeCursor)
  await f.claim(2)
  const next = await f.api.get(f.roomId, { changeCursor: first.nextChangeCursor! })
  assert.equal(next.activity!.changes.length, 6)
  assert.equal(next.nextChangeCursor, null)
  assert.equal(
    new Set([...first.activity!.changes, ...next.activity!.changes].map((c) => c.requestId)).size,
    26,
  )
  await f.session.open(f.roomId, f.ids[0]!)
  await f.session.loadMore('changes')
  assert.equal(f.session.store.getState().snapshot!.activity!.changes.length, 27)
})

test('cloud adapter uses shared action schema, numeric times, validates receipts and rejects inconsistent scores', async () => {
  const f = await setup()
  const snapshot = await f.api.get(f.roomId)
  assert.equal(isPointSnapshot(snapshot), true)
  const calls: unknown[] = []
  const api = createCloudPointApi('env-test', {
    init() {},
    async call(request) {
      calls.push(request)
      return request.action === 'point.getState'
        ? { ok: true, data: snapshot }
        : {
            ok: true,
            data: {
              requestId: 'requestId' in request ? request.requestId : '',
              roomId: f.roomId,
              activityId: snapshot.activity!.activityId,
            },
          }
    },
  })
  assert.deepEqual(await api.get(f.roomId), snapshot)
  await api.execute(
    f.roomId,
    {
      kind: 'claim',
      activityId: snapshot.activity!.activityId,
      number: 6,
      expectedCardRevision: 0,
    },
    'cloud-point-request',
  )
  assert.deepEqual(calls[1], {
    action: 'point.claim',
    requestId: 'cloud-point-request',
    payload: {
      roomId: f.roomId,
      activityId: snapshot.activity!.activityId,
      number: 6,
      expectedCardRevision: 0,
    },
  })
  const bad = structuredClone(snapshot)
  bad.activity!.earnedPoints[f.ids[0]!] = 6
  assert.equal(isPointSnapshot(bad), false)
  const invalid = createCloudPointApi('env-test', {
    init() {},
    async call() {
      return { ok: true, data: bad }
    },
  })
  await assert.rejects(invalid.get(f.roomId), { code: 'INVALID_RESPONSE' })
  const lost = createCloudPointApi('env-test', {
    init() {},
    async call() {
      throw new Error('network')
    },
  })
  await assert.rejects(
    lost.execute(
      f.roomId,
      { kind: 'post', activityId: snapshot.activity!.activityId, expectedActivityRevision: 0 },
      'cloud-lost-request',
    ),
    { code: 'TRANSPORT_UNKNOWN' },
  )
})

test('stale room reads cannot replace a later room or reopen an unloaded page', async () => {
  const f = await setup()
  let release: (() => void) | undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const fixture = await f.api.get(f.roomId)
  const api = {
    ...f.api,
    async get(roomId: string): Promise<PointSnapshot> {
      if (roomId === 'old') await barrier
      return { ...fixture, roomId }
    },
  }
  const session = createPointStore(api, f.requestId, f.journal)
  const old = session.open('old', f.ids[0]!)
  await session.open(f.roomId, f.ids[0]!)
  release!()
  await old
  assert.equal(session.store.getState().snapshot!.roomId, f.roomId)
  session.leave()
  assert.equal(session.store.getState().snapshot, null)
})

test('cloud frontend adapter interoperates with the real backend handlers through prepare, claims, post and next game', async () => {
  const { createApi } = await import('../../../cloud/src/services/api')
  const { MemoryStore } = await import('../../../cloud/test/memory-store')
  const store = new MemoryStore()
  let seq = 0
  let who = 'A'
  const call = (request: unknown) =>
    createApi(
      {
        store,
        id: (kind) => `${kind}_${++seq}`,
        joinCode: () => String(700000 + ++seq),
        now: () => 1790000000000 + seq,
      },
      () => ({ appId: 'wx-point-test', openId: who }),
    )(request)
  const ids: string[] = []
  for (const user of ['A', 'B', 'C']) {
    who = user
    const response = await call({ action: 'identity.getMe', payload: {} })
    assert.ok(response.ok)
    ids.push((response.data as { userId: string }).userId)
  }
  who = 'A'
  const created = await call({
    action: 'room.create',
    requestId: 'real-create-point',
    payload: { mode: 'point_ball' },
  })
  assert.ok(created.ok)
  const room = created.data as { roomId: string; joinCode: string }
  for (const user of ['B', 'C']) {
    who = user
    const joined = await call({
      action: 'room.join',
      requestId: `real-join-point-${user}`,
      payload: { joinCode: room.joinCode },
    })
    assert.ok(joined.ok)
  }
  who = 'A'
  const api = createCloudPointApi('local-memory-integration', { init() {}, call })
  const initial = await api.get(room.roomId)
  assert.equal(initial.activity, null)
  await api.execute(
    room.roomId,
    { kind: 'prepare', expectedRoomRevision: initial.roomRevision, participantIds: ids },
    'real-prepare-point',
  )
  const ready = await api.get(room.roomId)
  const allocation = [
    [15, 14, 13, 12, 6],
    [11, 10, 9, 8, 2],
    [1, 3, 4, 5, 7],
  ]
  for (let i = 0; i < allocation.length; i++) {
    who = ['A', 'B', 'C'][i]!
    for (const number of allocation[i]!)
      await api.execute(
        room.roomId,
        { kind: 'claim', activityId: ready.activity!.activityId, number, expectedCardRevision: 0 },
        `real-claim-point-${number}`,
      )
  }
  who = 'A'
  const complete = await api.get(room.roomId)
  assert.deepEqual(
    ids.map((id) => complete.activity!.earnedPoints[id]),
    [60, 40, 20],
  )
  await api.execute(
    room.roomId,
    {
      kind: 'post',
      activityId: complete.activity!.activityId,
      expectedActivityRevision: complete.activity!.revision,
    },
    'real-post-point',
  )
  const posted = await api.get(room.roomId)
  assert.deepEqual(
    ids.map((id) => posted.totals[id]),
    [20, 0, -20],
  )
  assert.equal(posted.activity!.status, 'posted')
  await api.execute(
    room.roomId,
    { kind: 'prepare', expectedRoomRevision: posted.roomRevision, participantIds: ids },
    'real-next-point',
  )
  const next = await api.get(room.roomId)
  assert.notEqual(next.activity!.activityId, posted.activity!.activityId)
  assert.equal(next.results.length, 1)
  assert.deepEqual(
    ids.map((id) => next.totals[id]),
    [20, 0, -20],
  )
})

test('result pagination appends only results while retaining server totals and not duplicating the change page', async () => {
  const f = await setup()
  await fillBalanced(f)
  const a = (await f.api.get(f.roomId)).activity!
  await f.api.execute(
    f.roomId,
    { kind: 'post', activityId: a.activityId, expectedActivityRevision: a.revision },
    f.requestId(),
  )
  const original = await f.api.get(f.roomId)
  const result = original.results[0]!
  const results = Array.from({ length: 21 }, (_, i) => ({
    ...structuredClone(result),
    activityId: i === 0 ? result.activityId : `older-result-${i}`,
  }))
  const totals = Object.fromEntries(
    Object.entries(result.deltas).map(([id, value]) => [id, value * 21]),
  )
  const api = {
    ...f.api,
    async get(_roomId: string, page?: { resultCursor?: string }) {
      return {
        ...original,
        results: page?.resultCursor ? results.slice(20) : results.slice(0, 20),
        nextResultCursor: page?.resultCursor ? null : 'next-result-page',
        totals,
      }
    },
  }
  const session = createPointStore(api, f.requestId, f.journal)
  await session.open(f.roomId, f.ids[0]!)
  assert.equal(session.store.getState().snapshot!.results.length, 20)
  assert.equal(session.store.getState().snapshot!.totals[f.ids[0]!], 420)
  const changeCount = session.store.getState().snapshot!.activity!.changes.length
  await session.loadMore('results')
  assert.equal(session.store.getState().snapshot!.results.length, 21)
  assert.equal(session.store.getState().snapshot!.activity!.changes.length, changeCount)
  assert.equal(session.store.getState().snapshot!.totals[f.ids[0]!], 420)
})

test('failed journal cleanup after acknowledged commit keeps original operation recoverable without duplicate score', async () => {
  const f = await setup()
  let pending: PointOperation[] = []
  let cleanupFails = true
  const journal = {
    read: () => pending,
    write(_userId: string, value: PointOperation[]) {
      if (!value.length && cleanupFails) throw new Error('cleanup failed')
      pending = structuredClone(value)
    },
  }
  const session = createPointStore(f.api, f.requestId, journal)
  await session.open(f.roomId, f.ids[0]!)
  const a = session.store.getState().snapshot!.activity!
  assert.equal(
    await session.submit({
      kind: 'claim',
      activityId: a.activityId,
      number: 6,
      expectedCardRevision: 0,
    }),
    false,
  )
  assert.equal(session.store.getState().requests[0]!.phase, 'unknown')
  cleanupFails = false
  await session.recover()
  assert.equal(session.store.getState().snapshot!.activity!.earnedPoints[f.ids[0]!], 6)
  assert.equal(session.store.getState().snapshot!.activity!.changes.length, 1)
  assert.equal(session.store.getState().requests.length, 0)
})

test('two-player baseline is 60; late members do not change it; mixed history retains each baseline', async () => {
  const s = await setup(2)
  s.late()
  for (let number = 1; number <= 15; number++) {
    s.act(number <= 10 ? s.ids[0]! : s.ids[1]!)
    await s.claim(number)
  }
  s.act(s.ids[0]!)
  let snapshot = await s.api.get(s.roomId)
  await s.api.execute(
    s.roomId,
    {
      kind: 'post',
      activityId: snapshot.activity!.activityId,
      expectedActivityRevision: snapshot.activity!.revision,
    },
    s.requestId(),
  )
  snapshot = await s.api.get(s.roomId)
  assert.deepEqual(snapshot.results[0]!.earnedPoints, { [s.ids[0]!]: 55, [s.ids[1]!]: 65 })
  assert.deepEqual(snapshot.results[0]!.deltas, { [s.ids[0]!]: -5, [s.ids[1]!]: 5 })
  assert.equal(isPointSnapshot(snapshot), true)
  const malformed = structuredClone(snapshot)
  malformed.results[0]!.deltas[s.ids[0]!] = 15
  assert.equal(isPointSnapshot(malformed), false)
  for (const participantIds of [
    [s.ids[0]!],
    [...s.ids, 'mock-point-1', 'late-member'],
    [s.ids[0]!, s.ids[0]!],
  ]) {
    await assert.rejects(
      s.api.execute(
        s.roomId,
        { kind: 'prepare', expectedRoomRevision: snapshot.roomRevision, participantIds },
        s.requestId(),
      ),
      { code: 'INVALID_ARGUMENT' },
    )
  }
  s.ids.push('mock-point-1')
  await s.prepare()
  for (let number = 1; number <= 15; number++) await s.claim(number)
  snapshot = await s.api.get(s.roomId)
  await s.api.execute(
    s.roomId,
    {
      kind: 'post',
      activityId: snapshot.activity!.activityId,
      expectedActivityRevision: snapshot.activity!.revision,
    },
    s.requestId(),
  )
  snapshot = await s.api.get(s.roomId)
  assert.deepEqual(
    snapshot.results.map((r) => r.participants.length),
    [3, 2],
  )
  assert.deepEqual(snapshot.results[0]!.deltas, {
    [s.ids[0]!]: 80,
    [s.ids[1]!]: -40,
    [s.ids[2]!]: -40,
  })
  assert.equal(isPointSnapshot(snapshot), true)
  assert.equal(
    Object.values(snapshot.totals).reduce((a, b) => a + b, 0),
    0,
  )
})

test('point taps protect fast success, pending requests and allow different targets', async () => {
  let time = 0
  const f = await setup(3, () => time)
  const a = f.session.store.getState().snapshot!.activity!
  const command = (number: number): PointCommand => ({
    kind: 'claim',
    activityId: a.activityId,
    number,
    expectedCardRevision: 0,
  })
  assert.equal(f.session.beginCardInteraction(a.activityId, 1), true)
  assert.equal(f.session.beginCardInteraction(a.activityId, 1), false)
  assert.equal(await f.session.submit(command(1)), true)
  assert.equal(f.session.beginCardInteraction(a.activityId, 1), false)
  assert.equal(await f.session.submit(command(1)), false)
  assert.equal(await f.session.submit(command(2)), true)
  time = 399
  assert.equal(f.session.beginCardInteraction(a.activityId, 1), false)
  time = 400
  assert.equal(f.session.beginCardInteraction(a.activityId, 1), true)
  let release!: () => void
  const execute = f.api.execute
  f.api.execute = async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return execute(...args)
  }
  const pending = f.session.submit(command(3))
  time = 1000
  assert.equal(await f.session.submit(command(3)), false)
  assert.equal(f.session.beginCardInteraction(a.activityId, 3), false)
  release()
  assert.equal(await pending, true)
  assert.equal(f.session.beginCardInteraction(a.activityId, 3), true)
  f.session.leave()
  assert.equal(f.session.beginCardInteraction(a.activityId, 3), false)
})

test('point parallel cards and unknown recovery never allocate IDs for rejected taps', async () => {
  let time = 0,
    serial = 0
  const f = await setup()
  const ids: string[] = []
  const execute = f.api.execute
  let release!: () => void
  let hold = true
  f.api.execute = async (...args) => {
    ids.push(args[2])
    if (hold && 'number' in args[1] && args[1].number === 1)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    return execute(...args)
  }
  const session = createPointStore(
    f.api,
    () => `protected-${++serial}`,
    f.journal,
    () => time,
  )
  await session.open(f.roomId, 'mock-me')
  const a = session.store.getState().snapshot!.activity!
  const command = (number: number): PointCommand => ({
    kind: 'claim',
    activityId: a.activityId,
    number,
    expectedCardRevision: 0,
  })
  const first = session.submit(command(1))
  assert.equal(await session.submit(command(1)), false)
  assert.equal(await session.submit(command(2)), true)
  assert.equal(serial, 2)
  time = 800
  assert.equal(await session.submit(command(1)), false)
  assert.equal(serial, 2)
  hold = false
  release()
  assert.equal(await first, true)
  f.api.execute = async (...args) => {
    ids.push(args[2])
    throw new Error('connection lost')
  }
  assert.equal(await session.submit(command(3)), false)
  assert.equal(serial, 3)
  assert.equal(await session.submit(command(4)), false)
  f.api.execute = async (...args) => {
    ids.push(args[2])
    return execute(...args)
  }
  await Promise.all([session.recover(), session.recover()])
  assert.equal(serial, 3)
  assert.deepEqual(ids.slice(-2), ['protected-3', 'protected-3'])
  assert.equal(session.store.getState().requests.length, 0)
  // A new room/activity may use the same number in the same 400ms window.
  const other = {
    ...session.store.getState().snapshot!,
    roomId: 'other-room',
    activity: { ...a, activityId: 'other-activity' },
  }
  session.store.setState({ roomId: 'other-room', snapshot: other })
  assert.equal(session.beginCardInteraction('other-activity', 3), true)
  assert.equal(session.beginCardInteraction(a.activityId, 3), false)
})

function pendingValue<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
test('point commit confirms in one write even when full refresh never resolves', async () => {
  let time = 0
  const f = await setup(3, () => time)
  const a = f.session.store.getState().snapshot!.activity!
  let reads = 0
  f.api.get = () => {
    reads++
    return new Promise(() => {})
  }
  const execute = f.api.execute
  const response = pendingValue<CommandReceipt | void>()
  f.api.execute = () => response.promise
  const command: PointCommand = {
    kind: 'claim',
    activityId: a.activityId,
    number: 6,
    expectedCardRevision: 0,
  }
  const operation = f.session.submit(command)
  const pending = f.session.store.getState().requests[0]!
  assert.equal(pending.phase, 'pending')
  assert.equal(f.session.store.getState().snapshot!.activity!.cards[5]!.ownerUserId, null)
  assert.equal(f.session.store.getState().snapshot!.activity!.earnedPoints['mock-me'], 0)
  const receipt = await execute(f.roomId, command, pending.requestId)
  response.resolve(receipt)
  assert.equal(await operation, true)
  assert.equal(reads, 0)
  assert.equal(f.session.store.getState().requests.length, 0)
  assert.equal(f.session.store.getState().snapshot!.activity!.earnedPoints['mock-me'], 6)
  assert.equal(f.session.store.getState().snapshot!.totals['mock-me'], 0)
  time = 400
  f.api.execute = execute
  assert.equal(
    await f.session.submit({
      kind: 'correct',
      activityId: a.activityId,
      number: 6,
      expectedCardRevision: 1,
      ownerUserId: f.ids[1]!,
    }),
    true,
  )
  assert.equal(f.session.store.getState().snapshot!.activity!.earnedPoints[f.ids[1]!], 6)
  assert.equal(reads, 0)
})

test('old point receipt still refreshes once; new mock replay keeps original projection', async () => {
  const f = await setup()
  const a = f.session.store.getState().snapshot!.activity!
  const execute = f.api.execute,
    get = f.api.get
  let reads = 0
  f.api.get = async (...args) => {
    reads++
    return get(...args)
  }
  f.api.execute = async (...args) => {
    await execute(...args)
  }
  assert.equal(
    await f.session.submit({
      kind: 'claim',
      activityId: a.activityId,
      number: 1,
      expectedCardRevision: 0,
    }),
    true,
  )
  assert.equal(reads, 1)
  const command: PointCommand = {
    kind: 'claim',
    activityId: a.activityId,
    number: 2,
    expectedCardRevision: 0,
  }
  const original = await execute(f.roomId, command, 'immutable-receipt')
  await execute(f.roomId, { ...command, number: 3 }, 'later-receipt')
  assert.deepEqual(await execute(f.roomId, command, 'immutable-receipt'), original)
  assert.equal(original!.pointState!.cards[2]!.ownerUserId, null)
})

test('parallel out-of-order point receipts retain latest board, loaded history and cursors', async () => {
  const f = await setup()
  const snapshot = f.session.store.getState().snapshot!
  const a = snapshot.activity!
  const historical = {
    requestId: 'loaded-history',
    number: 15,
    fromUserId: null,
    toUserId: 'mock-me',
    actorUserId: 'mock-me',
    actorName: '我',
    createdAt: 0,
  }
  f.session.store.setState({
    snapshot: {
      ...snapshot,
      nextChangeCursor: 'change-page',
      nextResultCursor: 'result-page',
      activity: { ...a, changes: [historical] },
    },
  })
  const execute = f.api.execute
  const one = pendingValue<CommandReceipt | void>(),
    two = pendingValue<CommandReceipt | void>()
  const committed: Promise<CommandReceipt | void>[] = []
  f.api.execute = (...args) => {
    committed.push(execute(...args))
    return committed.length === 1 ? one.promise : two.promise
  }
  const command = (number: number): PointCommand => ({
    kind: 'claim',
    activityId: a.activityId,
    number,
    expectedCardRevision: 0,
  })
  const first = f.session.submit(command(1)),
    second = f.session.submit(command(2))
  const firstReceipt = await committed[0]!,
    secondReceipt = await committed[1]!
  two.resolve(secondReceipt)
  assert.equal(await second, true)
  one.resolve(firstReceipt)
  assert.equal(await first, true)
  const current = f.session.store.getState().snapshot!
  assert.equal(current.activity!.revision, secondReceipt!.activityRevision)
  assert.equal(current.activity!.earnedPoints['mock-me'], 3)
  assert.equal(current.activity!.changes.length, 3)
  assert.equal(new Set(current.activity!.changes.map((c) => c.requestId)).size, 3)
  assert.equal(current.nextChangeCursor, 'change-page')
  assert.equal(current.nextResultCursor, 'result-page')
})

test('invalid point projection remains unknown and recovery reuses original request', async () => {
  let time = 0
  const f = await setup(3, () => time)
  const a = f.session.store.getState().snapshot!.activity!
  const execute = f.api.execute
  let originalId = ''
  f.api.execute = async (...args) => {
    originalId = args[2]
    const receipt = (await execute(...args))!
    receipt.pointState!.earnedPoints['mock-me'] = 119
    return receipt
  }
  assert.equal(
    await f.session.submit({
      kind: 'claim',
      activityId: a.activityId,
      number: 5,
      expectedCardRevision: 0,
    }),
    false,
  )
  assert.equal(f.session.store.getState().requests[0]!.phase, 'unknown')
  assert.equal(f.session.store.getState().snapshot!.activity!.earnedPoints['mock-me'], 0)
  f.api.execute = async (...args) => {
    assert.equal(args[2], originalId)
    return execute(...args)
  }
  time = 400
  await f.session.recover()
  assert.equal(f.session.store.getState().requests.length, 0)
  assert.equal(f.session.store.getState().snapshot!.activity!.earnedPoints['mock-me'], 5)
})

test('cloud rejects malformed projection, scores, versions and command bindings', async () => {
  const f = await setup()
  const a = f.session.store.getState().snapshot!.activity!
  const command: PointCommand = {
    kind: 'claim',
    activityId: a.activityId,
    number: 7,
    expectedCardRevision: 0,
  }
  const receipt = (await f.api.execute(f.roomId, command, 'validated-receipt'))!
  const valid = createCloudPointApi('env', {
    init() {},
    async call() {
      return { ok: true, data: receipt }
    },
  })
  assert.deepEqual(await valid.execute(f.roomId, command, receipt.requestId), receipt)
  const mutations: ((v: CommandReceipt) => void)[] = [
    (v) => {
      v.pointState!.cards.pop()
    },
    (v) => {
      v.pointState!.cards[0]!.number = 7
    },
    (v) => {
      v.pointState!.earnedPoints['mock-me'] = 8
    },
    (v) => {
      v.activityRevision = 99
    },
    (v) => {
      v.roomRevision = -1
    },
    (v) => {
      v.pointState!.activityId = 'other'
    },
    (v) => {
      v.pointState!.change.requestId = 'other'
    },
    (v) => {
      v.pointState!.change.number = 6
    },
    (v) => {
      v.pointState!.change.toUserId = f.ids[1]!
    },
    (v) => {
      v.pointState!.cards[6]!.lastModifiedBy = 'other'
    },
    (v) => {
      v.pointState!.cards[6]!.revision = 0
    },
    (v) => {
      v.pointState!.cards[0]!.ownerUserId = 'outsider'
    },
  ]
  for (const mutate of mutations) {
    const malformed = structuredClone(receipt)
    mutate(malformed)
    const api = createCloudPointApi('env', {
      init() {},
      async call() {
        return { ok: true, data: malformed }
      },
    })
    await assert.rejects(api.execute(f.roomId, command, receipt.requestId), {
      code: 'INVALID_RESPONSE',
    })
  }
})

test('late commit cannot populate a newly opened room or identity', async () => {
  for (const identityChange of [false, true]) {
    const f = await setup()
    const before = f.session.store.getState().snapshot!,
      a = before.activity!
    const execute = f.api.execute
    const response = pendingValue<CommandReceipt | void>()
    let committed!: Promise<CommandReceipt | void>
    f.api.execute = (...args) => {
      committed = execute(...args)
      return response.promise
    }
    const operation = f.session.submit({
      kind: 'claim',
      activityId: a.activityId,
      number: 8,
      expectedCardRevision: 0,
    })
    const receipt = await committed
    const nextRoom = identityChange ? f.roomId : 'another-room'
    const nextUser = identityChange ? f.ids[1]! : 'mock-me'
    const nextRead = pendingValue<PointSnapshot>()
    f.api.get = () => nextRead.promise
    const opening = f.session.open(nextRoom, nextUser)
    response.resolve(receipt)
    assert.equal(await operation, true)
    assert.equal(f.session.store.getState().snapshot, null)
    assert.equal(f.session.store.getState().roomId, nextRoom)
    assert.equal(f.session.store.getState().userId, nextUser)
    nextRead.resolve({ ...before, roomId: nextRoom })
    await opening
    assert.equal(f.session.store.getState().snapshot!.activity!.earnedPoints['mock-me'], 0)
  }
})

test('returned card can be claimed by another participant without changing its initial recorder', async () => {
  const f = await setup()
  const a = f.session.store.getState().snapshot!.activity!
  const claim: PointCommand = {
    kind: 'claim',
    activityId: a.activityId,
    number: 9,
    expectedCardRevision: 0,
  }
  await f.api.execute(f.roomId, claim, 'original-claim')
  await f.api.execute(
    f.roomId,
    {
      kind: 'correct',
      activityId: a.activityId,
      number: 9,
      expectedCardRevision: 1,
      ownerUserId: null,
    },
    'return-card',
  )
  f.act(f.ids[1]!)
  const next = { ...claim, expectedCardRevision: 2 }
  const receipt = (await f.api.execute(f.roomId, next, 'next-claim'))!
  const api = createCloudPointApi('env', {
    init() {},
    async call() {
      return { ok: true, data: receipt }
    },
  })
  assert.deepEqual(await api.execute(f.roomId, next, 'next-claim'), receipt)
  assert.equal(receipt.pointState!.cards[8]!.initialRecordedBy, 'mock-me')
  assert.equal(receipt.pointState!.cards[8]!.ownerUserId, f.ids[1])
})

test('historical idempotent projection cannot rewind current board or duplicate loaded change', async () => {
  const f = await setup()
  const a = f.session.store.getState().snapshot!.activity!
  const command: PointCommand = {
    kind: 'claim',
    activityId: a.activityId,
    number: 1,
    expectedCardRevision: 0,
  }
  await f.api.execute(f.roomId, command, 'historical-replay')
  await f.api.execute(f.roomId, { ...command, number: 2 }, 'newer-change')
  f.journal.write('mock-me', [{ roomId: f.roomId, requestId: 'historical-replay', command }])
  await f.session.open(f.roomId, 'mock-me')
  const before = structuredClone(f.session.store.getState().snapshot)
  const get = f.api.get
  let reads = 0
  f.api.get = (...args) => {
    reads++
    return get(...args)
  }
  await f.session.recover()
  assert.deepEqual(f.session.store.getState().snapshot, before)
  assert.equal(f.session.store.getState().requests.length, 0)
  assert.equal(reads, 0)
})

test('late success and failure clean only the originating user journal, never another identity', async () => {
  for (const outcome of ['success', 'definite', 'unknown'] as const) {
    const f = await setup()
    const a = f.session.store.getState().snapshot!.activity!
    const journals = new Map<string, PointOperation[]>()
    const journal = {
      read: (userId: string) => structuredClone(journals.get(userId) ?? []),
      write: (userId: string, requests: PointOperation[]) => {
        journals.set(userId, structuredClone(requests))
      },
    }
    const reply = pendingValue<CommandReceipt | void>()
    const execute = f.api.execute
    f.api.execute = () => reply.promise
    const session = createPointStore(
      f.api,
      () => 'origin-operation',
      journal,
      () => 0,
    )
    await session.open(f.roomId, 'mock-me')
    const command: PointCommand = {
      kind: 'claim',
      activityId: a.activityId,
      number: 10,
      expectedCardRevision: 0,
    }
    const operation = session.submit(command)
    const original = journal.read('mock-me')[0]!
    const sibling = { ...original, requestId: 'origin-sibling' }
    journal.write('mock-me', [original, sibling])
    const other: PointOperation = {
      roomId: 'other-room',
      requestId: 'other-operation',
      command: { ...command, activityId: 'other-activity' },
    }
    journal.write('other-user', [other])
    session.leave()
    session.store.setState({
      roomId: 'other-room',
      userId: 'other-user',
      requests: [{ ...other, phase: 'unknown' }],
    })
    const before = structuredClone(session.store.getState())
    if (outcome === 'success') reply.resolve(await execute(f.roomId, command, original.requestId))
    else
      reply.reject(
        outcome === 'definite' ? new RoomApiError('FORBIDDEN', 'rejected') : new Error('lost'),
      )
    await operation
    assert.deepEqual(session.store.getState(), before)
    assert.deepEqual(journal.read('other-user'), [other])
    assert.deepEqual(
      journal.read('mock-me'),
      outcome === 'unknown' ? [original, sibling] : [sibling],
    )
  }
})
