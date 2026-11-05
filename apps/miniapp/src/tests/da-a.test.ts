import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DA_A_VALUES, daADeltaUnits } from '@scoreboard/shared'
import type { DaAEntry, DaASnapshot, CommandReceipt } from '@scoreboard/shared'
import { createMockRoomApi } from '../modules/room-api/mock'
import { createCloudRoomApi } from '../modules/room-api/cloud'
import { RoomApiError } from '../modules/room-api/errors'
import { createMockDaAApi } from '../features/da-a/mock'
import { createCloudDaAApi, formatUnits, signedUnits, isDaASnapshot } from '../features/da-a/api'
import type { DaAApi, DaACommand } from '../features/da-a/api'
import { createDaAStore } from '../features/da-a/store'
import type { DaAPending } from '../features/da-a/store'
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function setup(
  prepared = true,
  now = (() => {
    let time = 0
    return () => (time += 400)
  })(),
) {
  let roomData: unknown,
    data: unknown,
    pending: DaAPending | null = null
  const base = createMockRoomApi({
    delayMs: 0,
    storage: {
      read: () => roomData,
      write(v: unknown) {
        roomData = structuredClone(v)
      },
    },
  })
  const joined = await base.joinRoom('628389', 'join-da-a-test')
  let actor = 'mock-me',
    late = false
  const roomApi = {
    ...base,
    async getMe() {
      return { userId: actor, displayName: actor }
    },
    async getRoomSnapshot(id: string) {
      const room = await base.getRoomSnapshot(id)
      return late
        ? {
            ...room,
            memberCount: 6,
            revision: room.revision + 1,
            members: [
              ...room.members,
              { userId: 'late', displayName: '迟到者', joinedAt: new Date().toISOString() },
            ],
          }
        : room
    },
  }
  const storage = {
    read: () => data,
    write(v: unknown) {
      data = structuredClone(v)
    },
  }
  const api = createMockDaAApi(roomApi, storage)
  const roomId = joined.roomId
  const ids = (await roomApi.getRoomSnapshot(roomId)).members.map((p) => p.userId)
  const journal = {
    read: () => pending,
    write(_id: string, v: DaAPending | null) {
      pending = v ? structuredClone(v) : null
    },
  }
  let serial = 0
  const makeId = () => `daa-test-request-${++serial}`
  if (prepared)
    await api.execute(
      roomId,
      {
        kind: 'prepare',
        expectedRoomRevision: (await api.get(roomId)).roomRevision,
        participantIds: ids,
      },
      makeId(),
    )
  const session = createDaAStore(api, makeId, journal, now)
  await session.open(roomId, actor)
  return {
    api,
    roomApi,
    roomId,
    ids,
    storage,
    journal,
    session,
    makeId,
    act(id: string) {
      actor = id
    },
    late() {
      late = true
    },
  }
}
const delta = (
  s: DaASnapshot,
  patch: Partial<Extract<DaACommand, { kind: 'delta' }>> = {},
): DaACommand => ({
  kind: 'delta',
  activityId: s.activity!.activityId,
  expectedConfigRevision: s.activity!.configRevision,
  direction: 1,
  value: 6,
  mingA: false,
  ...patch,
})
test('daA formula and units presentation cover all 96 preset combinations without implicit money floats', () => {
  let count = 0
  for (const base of [1, 5, 10])
    for (const direction of [1, -1])
      for (const value of DA_A_VALUES)
        for (const mingA of [true, false]) {
          const units = daADeltaUnits(base, direction, value, mingA)
          assert.equal(formatUnits(units), String(base * direction * value * (mingA ? 2 : 1)))
          count++
        }
  assert.equal(count, 96)
  assert.equal(formatUnits(-1234), '-12.34')
  assert.equal(formatUnits(1250), '12.5')
  assert.equal(signedUnits(0), '0')
})
test('fixed five-person prepare validates members; late joins do not change frozen names or canRecord', async () => {
  const s = await setup(false)
  const initial = await s.api.get(s.roomId)
  for (const ids of [
    s.ids.slice(0, 4),
    [...s.ids.slice(0, 4), s.ids[0]!],
    [...s.ids.slice(0, 4), 'outsider'],
  ])
    await assert.rejects(
      s.api.execute(
        s.roomId,
        { kind: 'prepare', expectedRoomRevision: initial.roomRevision, participantIds: ids },
        s.makeId(),
      ),
    )
  const cmd: DaACommand = {
    kind: 'prepare',
    expectedRoomRevision: initial.roomRevision,
    participantIds: s.ids,
  }
  await s.api.execute(s.roomId, cmd, s.makeId())
  const before = await s.api.get(s.roomId)
  s.late()
  const after = await s.api.get(s.roomId)
  assert.deepEqual(after.activity!.participants, before.activity!.participants)
  assert.equal(after.canRecord, true)
  s.act('late')
  assert.equal((await s.api.get(s.roomId)).canRecord, false)
  await assert.rejects(s.api.execute(s.roomId, delta(after), s.makeId()), { code: 'FORBIDDEN' })
})
test('save resets only confirmed selection/mingA; known failure and unknown keep input and original ID', async () => {
  const s = await setup()
  s.session.select({ direction: -1, value: 6, mingA: true })
  s.api.failNext()
  assert.equal(await s.session.submit(), false)
  assert.equal(s.session.store.getState().draft.mingA, true)
  assert.equal(s.session.store.getState().draft.value, 6)
  await s.session.refresh()
  assert.match(s.session.store.getState().error!, /未保存/)
  s.api.loseNextResponse()
  assert.equal(await s.session.submit(), false)
  const original = s.session.store.getState().pending!
  const reload = createDaAStore(s.api, () => 'must-not-create-new-id', s.journal)
  await reload.open(s.roomId, 'mock-me')
  assert.equal(reload.store.getState().draft.mingA, true)
  await Promise.all([reload.submit(), reload.submit()])
  assert.equal(reload.store.getState().pending, null)
  assert.equal(reload.store.getState().draft.mingA, false)
  assert.equal(reload.store.getState().draft.value, null)
  const snapshot = await s.api.get(s.roomId)
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.entries[0]!.requestId, original.requestId)
  assert.equal(snapshot.totalsUnits['mock-me'], -6000)
  assert.equal(snapshot.totalsUnits[s.ids.find((id) => id !== 'mock-me')!], undefined)
})
test('prepare lost response restores original command without creating a second activity', async () => {
  const s = await setup(false)
  s.api.loseNextResponse()
  const cmd: DaACommand = {
    kind: 'prepare',
    expectedRoomRevision: (await s.api.get(s.roomId)).roomRevision,
    participantIds: s.ids,
  }
  assert.equal(await s.session.submit(cmd), false)
  const activity = (await s.api.get(s.roomId)).activity!.activityId
  const reload = createDaAStore(s.api, () => 'unused-new', s.journal)
  await reload.open(s.roomId, 'mock-me')
  assert.equal(await reload.submit(), true)
  assert.equal((await s.api.get(s.roomId)).activity!.activityId, activity)
})
test('pagination deduplicates and cannot replace authoritative totals with page totals; refresh keeps loaded history', async () => {
  const s = await setup()
  for (let i = 0; i < 25; i++)
    await s.api.execute(s.roomId, delta(await s.api.get(s.roomId), { value: 1 }), s.makeId())
  await s.session.refresh()
  assert.equal(s.session.store.getState().snapshot!.entries.length, 20)
  await s.session.loadMore()
  assert.equal(s.session.store.getState().snapshot!.entries.length, 25)
  assert.equal(s.session.store.getState().snapshot!.totalsUnits['mock-me'], 12500)
  await s.session.refresh()
  assert.equal(s.session.store.getState().snapshot!.entries.length, 25)
})
test('visible permission refresh removes recording controls; offline does not write and corrupt journal blocks submission', async () => {
  const s = await setup()
  let denied = false
  let writes = 0
  const api: DaAApi = {
    async get(id, cursor) {
      if (denied) throw new RoomApiError('FORBIDDEN', 'removed')
      return s.api.get(id, cursor)
    },
    async execute(...args) {
      writes++
      return s.api.execute(...args)
    },
  }
  const session = createDaAStore(api, s.makeId, s.journal)
  await session.open(s.roomId, 'mock-me')
  session.select({ value: 1 })
  session.setOnline(false)
  assert.equal(await session.submit(), false)
  assert.equal(writes, 0)
  session.setOnline(true)
  denied = true
  await session.refresh()
  assert.equal(session.store.getState().snapshot, null)
  const bad = createDaAStore(api, s.makeId, {
    read() {
      throw new Error('corrupt')
    },
    write() {},
  })
  await bad.open(s.roomId, 'mock-me')
  assert.equal(await bad.submit(), false)
  assert.equal(writes, 0)
})
test('late reads and late writes do not pollute another room or identity; old receipt does not become a new score', async () => {
  const s = await setup()
  const read = deferred<DaASnapshot>()
  const fixture = await s.api.get(s.roomId)
  const api: DaAApi = {
    ...s.api,
    get: async (id) => (id === 'old' ? read.promise : { ...fixture, roomId: id }),
  }
  const session = createDaAStore(api, s.makeId, s.journal)
  const opening = session.open('old', 'A')
  await session.open('new', 'B')
  read.resolve({ ...fixture, roomId: 'old' })
  await opening
  assert.equal(session.store.getState().snapshot!.roomId, 'new')
  assert.equal(session.store.getState().userId, 'B')
  const receipt = deferred<CommandReceipt>()
  const writing: DaAApi = {
    ...api,
    async execute() {
      return receipt.promise
    },
  }
  const writes = createDaAStore(writing, s.makeId, s.journal)
  await writes.open(s.roomId, 'mock-me')
  writes.select({ value: 1 })
  const pending = writes.submit()
  const next = writes.open('other', 'other-user')
  receipt.resolve({
    entityId: 'entry',
    activityId: fixture.activity!.activityId,
    roomId: s.roomId,
    requestId: 'old-receipt',
  })
  await pending
  await next
  assert.equal(writes.store.getState().roomId, 'other')
  assert.equal(writes.store.getState().pending, null)
  assert.equal(writes.store.getState().feedback, null)
})
test('cloud adapter sends only allowed command fields and rejects invalid snapshots or wrong receipts', async () => {
  const s = await setup(),
    snapshot = await s.api.get(s.roomId)
  assert.equal(isDaASnapshot(snapshot), true)
  const invalid = structuredClone(snapshot)
  invalid.activity!.participants.pop()
  assert.equal(isDaASnapshot(invalid), false)
  const requests: unknown[] = []
  const cloud = createCloudDaAApi(async (req) => {
    requests.push(req)
    return {
      ok: true,
      data:
        req.action === 'daA.getState'
          ? snapshot
          : {
              requestId: 'cloud-write-request',
              entityId: 'entry',
              roomId: s.roomId,
              activityId: snapshot.activity!.activityId,
            },
    }
  })
  await cloud.get(s.roomId)
  await cloud.execute(s.roomId, delta(snapshot), 'cloud-write-request')
  assert.deepEqual(
    Object.keys((requests[1] as { payload: object }).payload).sort(),
    ['roomId', 'activityId', 'expectedConfigRevision', 'direction', 'value', 'mingA'].sort(),
  )
  const bad = createCloudDaAApi(async () => ({
    ok: true,
    data: {
      requestId: 'cloud-write-request',
      entityId: 'entry',
      roomId: 'wrong',
      activityId: snapshot.activity!.activityId,
    },
  }))
  await assert.rejects(bad.execute(s.roomId, delta(snapshot), 'cloud-write-request'), {
    code: 'INVALID_RESPONSE',
  })
  const roomApi = createCloudRoomApi('env', {
    init() {},
    async call(req) {
      assert.equal(req.action, 'daA.createRoom')
      return { ok: true, data: { roomId: 'created', requestId: 'create-da-a-request' } }
    },
  })
  assert.equal((await roomApi.createPokerRoom!('da_a', 5, 'create-da-a-request')).roomId, 'created')
  await assert.rejects(roomApi.createPokerRoom!('dui_jia', 5, 'no-dui-change'), {
    code: 'RULE_NOT_CONFIGURED',
  })
})
test('real backend handlers interoperate with frontend create/prepare/save/replay/pagination and frozen late join', async () => {
  const { createApi } = await import('../../../cloud/src/services/api')
  const { MemoryStore } = await import('../../../cloud/test/memory-store')
  const store = new MemoryStore()
  let seq = 0,
    who = 'A',
    clock = 1790000000000
  const call = (request: unknown) =>
    createApi(
      {
        store,
        id: (kind) => `${kind}_${++seq}`,
        joinCode: () => String(710000 + ++seq),
        now: () => (clock += 1000),
      },
      () => ({ appId: 'wx-daa-front-test', openId: who }),
    )(request)
  const ids: string[] = []
  for (const actor of ['A', 'B', 'C', 'D', 'E', 'F']) {
    who = actor
    const me = await call({ action: 'identity.getMe', payload: {} })
    assert.ok(me.ok)
    ids.push((me.data as { userId: string }).userId)
  }
  who = 'A'
  const rooms = createCloudRoomApi('local', { init() {}, call })
  const created = await rooms.createPokerRoom!('da_a', 5, 'backend-da-a-create')
  const preview = await call({ action: 'room.getSnapshot', payload: { roomId: created.roomId } })
  assert.ok(preview.ok)
  const code = (preview.data as { joinCode: string }).joinCode
  for (const actor of ['B', 'C', 'D', 'E']) {
    who = actor
    assert.ok(
      (
        await call({
          action: 'room.join',
          requestId: `backend-da-a-join-${actor}`,
          payload: { joinCode: code },
        })
      ).ok,
    )
  }
  who = 'A'
  const api = createCloudDaAApi(call)
  const before = await api.get(created.roomId)
  await api.execute(
    created.roomId,
    { kind: 'prepare', expectedRoomRevision: before.roomRevision, participantIds: ids.slice(0, 5) },
    'backend-da-a-prepare',
  )
  who = 'F'
  assert.ok(
    (
      await call({
        action: 'room.join',
        requestId: 'backend-da-a-late',
        payload: { joinCode: code },
      })
    ).ok,
  )
  assert.equal((await api.get(created.roomId)).canRecord, false)
  who = 'A'
  const fixed = await api.get(created.roomId)
  assert.equal(fixed.activity!.participants.length, 5)
  const command = delta(fixed, { direction: -1, value: 6, mingA: true })
  await api.execute(created.roomId, command, 'backend-da-a-delta')
  await api.execute(created.roomId, command, 'backend-da-a-delta')
  for (let i = 0; i < 22; i++) {
    clock += 61000
    await api.execute(created.roomId, delta(fixed, { value: 1 }), `backend-da-a-page-${i}`)
  }
  const page = await api.get(created.roomId)
  assert.equal(page.entries.length, 20)
  assert.equal(page.totalsUnits[ids[0]!], 5000)
  const next = await api.get(created.roomId, page.nextCursor!)
  assert.equal(next.entries.length, 3)
  assert.equal(next.totalsUnits[ids[0]!], 5000)
  assert.equal(page.totalsUnits[ids[1]!], undefined)
})

test('loadMore is not preempted by refresh and incorporates newer server totals', async () => {
  const s = await setup(),
    fixture = await s.api.get(s.roomId)
  const entry = (index: number): DaAEntry => ({
    entryId: `entry-${index}`,
    requestId: `request-${index}`,
    roomId: s.roomId,
    activityId: fixture.activity!.activityId,
    userId: 'mock-me',
    displayName: '我',
    direction: 1,
    value: 1,
    baseStake: 5,
    mingA: false,
    deltaUnits: 500,
    savedAt: index,
  })
  const page = deferred<DaASnapshot>()
  let calls = 0
  const api: DaAApi = {
    ...s.api,
    async get(_id, cursor) {
      calls++
      return cursor
        ? page.promise
        : {
            ...fixture,
            entries: Array.from({ length: 20 }, (_, i) => entry(i)),
            nextCursor: 'next-page',
            totalsUnits: { 'mock-me': 12500 },
          }
    },
  }
  const session = createDaAStore(api, s.makeId, s.journal)
  await session.open(s.roomId, 'mock-me')
  const loading = session.loadMore()
  await session.refresh()
  assert.equal(calls, 2)
  page.resolve({
    ...fixture,
    activity: { ...fixture.activity!, revision: 1 },
    entries: Array.from({ length: 6 }, (_, i) => entry(i + 19)),
    nextCursor: null,
    totalsUnits: { 'mock-me': 13000 },
  })
  await loading
  assert.equal(session.store.getState().snapshot!.entries.length, 25)
  assert.equal(session.store.getState().snapshot!.totalsUnits['mock-me'], 13000)
  await session.refresh()
  assert.equal(session.store.getState().snapshot!.entries.length, 25)
})
test('unknown delta restores frozen old activity/config even after a new snapshot has arrived', async () => {
  const s = await setup(),
    fixture = await s.api.get(s.roomId)
  const operation: DaAPending = {
    roomId: s.roomId,
    userId: 'mock-me',
    requestId: 'restore-original-activity',
    command: delta(fixture, { mingA: true }),
  }
  const sent: DaACommand[] = []
  let saved: DaAPending | null = operation
  const next = {
    ...fixture,
    activity: { ...fixture.activity!, activityId: 'next-activity', configRevision: 42 },
  }
  const api: DaAApi = {
    get: async () => next,
    async execute(roomId, command, requestId) {
      sent.push(command)
      return { requestId, roomId, entityId: 'old-entry', activityId: fixture.activity!.activityId }
    },
  }
  const session = createDaAStore(api, () => 'never-new', {
    read: () => saved,
    write(_id, value) {
      saved = value
    },
  })
  await session.open(s.roomId, 'mock-me')
  assert.equal(await session.submit(), true)
  assert.deepEqual(sent, [operation.command])
  assert.equal(session.store.getState().snapshot!.activity!.activityId, 'next-activity')
  assert.match(session.store.getState().feedback!, /本场未新增/)
})
test('late failed write keeps its own journal and cannot set error/pending on a different identity', async () => {
  const s = await setup(),
    fixture = await s.api.get(s.roomId),
    response = deferred<CommandReceipt>()
  const journal = new Map<string, DaAPending | null>()
  const api: DaAApi = {
    get: async (id) => ({ ...fixture, roomId: id }),
    execute: async () => response.promise,
  }
  const session = createDaAStore(api, s.makeId, {
    read: (id) => journal.get(id) ?? null,
    write(id, value) {
      journal.set(id, value)
    },
  })
  await session.open(s.roomId, 'mock-me')
  session.select({ value: 1 })
  const write = session.submit()
  const next = session.open('B-room', 'B')
  response.reject(new RoomApiError('TRANSPORT_UNKNOWN', 'A response lost'))
  await write
  await next
  assert.equal(session.store.getState().userId, 'B')
  assert.equal(session.store.getState().error, null)
  assert.equal(session.store.getState().pending, null)
  assert.ok(journal.get('mock-me'))
  assert.equal(journal.get('B'), undefined)
})

test('journal failure before send never writes; failed journal clear after success retains recoverable original command', async () => {
  const s = await setup()
  let writes = 0,
    pending: DaAPending | null = null,
    rejectClear = true
  const api: DaAApi = {
    ...s.api,
    async execute(...args) {
      writes++
      return s.api.execute(...args)
    },
  }
  const failed = createDaAStore(api, s.makeId, {
    read: () => null,
    write() {
      throw new Error('disk unavailable')
    },
  })
  await failed.open(s.roomId, 'mock-me')
  failed.select({ value: 1 })
  assert.equal(await failed.submit(), false)
  assert.equal(writes, 0)
  const journal = {
    read: () => pending,
    write(_id: string, value: DaAPending | null) {
      if (!value && rejectClear) throw new Error('clear failed')
      pending = value
    },
  }
  let retryTime = 0
  const session = createDaAStore(api, s.makeId, journal, () => retryTime)
  await session.open(s.roomId, 'mock-me')
  session.select({ value: 1, mingA: true })
  assert.equal(await session.submit(), false)
  const original = session.store.getState().pending!
  assert.equal(session.store.getState().draft.mingA, true)
  rejectClear = false
  retryTime = 400
  assert.equal(await session.submit(), true)
  const snapshot = await s.api.get(s.roomId)
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.entries[0]!.requestId, original.requestId)
  assert.equal(snapshot.totalsUnits['mock-me'], 1000)
})
test('units formatter preserves safe integer minor-unit precision for large cumulative values', () => {
  assert.equal(formatUnits(Number.MAX_SAFE_INTEGER), '90071992547409.91')
  assert.equal(formatUnits(-Number.MAX_SAFE_INTEGER), '-90071992547409.91')
})

test('daA leading click protection keeps slow flight, original retry ID and room isolation', async () => {
  let time = 0
  const f = await setup(true, () => time)
  const calls: string[] = []
  const execute = f.api.execute
  f.api.execute = async (...args) => {
    calls.push(args[2])
    return execute(...args)
  }
  f.session.select({ value: 1 })
  const first = f.session.submit()
  assert.equal(f.session.submit(), first)
  assert.equal(await first, true)
  f.session.select({ value: 2 })
  assert.equal(await f.session.submit(), false)
  assert.equal(f.session.store.getState().draft.value, 2)
  assert.equal(calls.length, 1)
  time = 400
  let release!: () => void
  f.api.execute = async (...args) => {
    calls.push(args[2])
    await new Promise<void>((resolve) => {
      release = resolve
    })
    throw new RoomApiError('TRANSPORT_UNKNOWN', 'unknown')
  }
  const slow = f.session.submit()
  time = 1000
  assert.equal(f.session.submit(), slow)
  release()
  assert.equal(await slow, false)
  const original = f.session.store.getState().pending!.requestId
  f.api.execute = async (...args) => {
    calls.push(args[2])
    return execute(...args)
  }
  assert.equal(await f.session.submit(), true)
  assert.equal(calls.at(-1), original)
  assert.equal(calls.length, 3)
  f.session.select({ value: 1 })
  time = 1399
  assert.equal(await f.session.submit(), false)
  time = 1400
  assert.equal(await f.session.submit(), true)
  f.session.leave()
  assert.equal(await f.session.submit(), false)
})
