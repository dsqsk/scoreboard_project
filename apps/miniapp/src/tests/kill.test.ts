import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockRoomApi } from '../modules/room-api/mock'
import { createMockKillApi } from '../features/kill/api'
import type { KillCommand } from '../features/kill/api'
import { createKillStore } from '../features/kill/store'
import type { PendingKill } from '../features/kill/store'
import { RoomApiError } from '../modules/room-api/errors'

async function setup() {
  let roomData: unknown
  const base = createMockRoomApi({
    storage: {
      read: () => roomData,
      write: (value) => {
        roomData = structuredClone(value)
      },
    },
    delayMs: 0,
  })
  await base.joinRoom('628391', 'join')
  let actor = 'mock-me'
  const roomApi = {
    ...base,
    async getMe() {
      return { userId: actor, displayName: actor }
    },
  }
  let data: unknown
  let fail = false
  const storage = {
    read: () => structuredClone(data),
    write(value: unknown) {
      if (fail) throw new Error('disk failure')
      data = structuredClone(value)
    },
  }
  const api = createMockKillApi(roomApi, storage, () => 0.25)
  const roomId = 'mock-example'
  const ids = ['mock-me', 'mock-lin', 'mock-zhou']
  await api.execute(roomId, { kind: 'deal', participantIds: ids }, 'deal')
  return {
    api,
    roomApi,
    storage,
    roomId,
    ids,
    act(id: string) {
      actor = id
    },
    fail(value: boolean) {
      fail = value
    },
  }
}

test('deal is unique, private, stable across adapters and protected against repeated deals', async () => {
  const { api, roomId, ids, act, roomApi, storage } = await setup()
  const numbers: number[] = []
  for (const id of ids) {
    act(id)
    const snapshot = (await api.get(roomId))!
    assert.equal(snapshot.ownBalls.length, 5)
    assert.equal(snapshot.remaining[id], 5)
    assert.deepEqual(Object.keys(snapshot.ownBalls[0]!).sort(), ['number', 'potted'])
    numbers.push(...snapshot.ownBalls.map((b) => b.number))
    assert.deepEqual(await createMockKillApi(roomApi, storage).get(roomId), snapshot)
  }
  assert.deepEqual(
    numbers.sort((a, b) => a - b),
    Array.from({ length: 15 }, (_, i) => i + 1),
  )
  act('mock-me')
  await api.execute(roomId, { kind: 'deal', participantIds: ids }, 'deal')
  await assert.rejects(api.execute(roomId, { kind: 'deal', participantIds: ids }, 'deal-again'), {
    code: 'CONFLICT',
  })
})

test('pot and independent undo are idempotent; only owner can pot', async () => {
  const { api, roomId, act } = await setup()
  const start = (await api.get(roomId))!
  const number = start.ownBalls[0]!.number
  const command: KillCommand = { kind: 'pot', number, potted: true, revision: start.revision }
  await api.execute(roomId, command, 'pot')
  await api.execute(roomId, command, 'pot')
  const potted = (await api.get(roomId))!
  assert.equal(potted.remaining['mock-me'], 4)
  await api.execute(roomId, { ...command, revision: potted.revision }, 'same-state')
  const beforeUndo = (await api.get(roomId))!
  const undo: KillCommand = { kind: 'pot', number, potted: false, revision: beforeUndo.revision }
  await api.execute(roomId, undo, 'undo')
  await api.execute(roomId, undo, 'undo')
  assert.equal((await api.get(roomId))!.remaining['mock-me'], 5)
  act('mock-lin')
  await assert.rejects(
    api.execute(roomId, { ...undo, revision: (await api.get(roomId))!.revision }, 'not-owner'),
    { code: 'FORBIDDEN' },
  )
})

test('transfer updates both counts and preserves initial owner; potted transfer does not decrease old remaining', async () => {
  const { api, roomId, act, storage } = await setup()
  act('mock-lin')
  const lin = (await api.get(roomId))!
  const [unpaid, paid] = lin.ownBalls
  await api.execute(
    roomId,
    { kind: 'pot', number: paid!.number, potted: true, revision: lin.revision },
    'lin-pot',
  )
  act('mock-me')
  let current = (await api.get(roomId))!
  await api.execute(
    roomId,
    { kind: 'transfer', number: unpaid!.number, revision: current.revision },
    'transfer1',
  )
  current = (await api.get(roomId))!
  assert.equal(current.remaining['mock-me'], 6)
  assert.equal(current.remaining['mock-lin'], 3)
  await api.execute(
    roomId,
    { kind: 'transfer', number: paid!.number, revision: current.revision },
    'transfer2',
  )
  current = (await api.get(roomId))!
  assert.equal(current.remaining['mock-me'], 7)
  assert.equal(current.remaining['mock-lin'], 3)
  assert.equal(current.ownBalls.find((b) => b.number === paid!.number)!.potted, false)
  const stored = storage.read() as {
    rounds: Record<string, { balls: { number: number; initialOwnerId: string }[] }>
  }
  assert.equal(
    stored.rounds[roomId]!.balls.find((b) => b.number === paid!.number)!.initialOwnerId,
    'mock-lin',
  )
})

test('racing transfers have one winner; failed durable writes leave confirmed state intact', async () => {
  const { api, roomId, act, fail } = await setup()
  const start = (await api.get(roomId))!
  const number = start.ownBalls[0]!.number
  act('mock-lin')
  await api.execute(roomId, { kind: 'transfer', number, revision: start.revision }, 'first')
  act('mock-zhou')
  await assert.rejects(
    api.execute(roomId, { kind: 'transfer', number, revision: start.revision }, 'second'),
    { code: 'CONFLICT' },
  )
  const before = (await api.get(roomId))!
  fail(true)
  await assert.rejects(
    api.execute(roomId, { kind: 'transfer', number, revision: before.revision }, 'disk-fail'),
  )
  assert.deepEqual(await api.get(roomId), before)
})

test('saving stores one zero-sum result, accepts more than five remaining, and locks play', async () => {
  const { api, roomId } = await setup()
  const current = (await api.get(roomId))!
  const command: KillCommand = {
    kind: 'save',
    winnerId: 'mock-me',
    remaining: { 'mock-lin': 6, 'mock-zhou': 3 },
    revision: current.revision,
  }
  await api.execute(roomId, command, 'save')
  await api.execute(roomId, command, 'save')
  const saved = (await api.get(roomId))!
  assert.deepEqual(saved.result!.scores, { 'mock-me': 9, 'mock-lin': -6, 'mock-zhou': -3 })
  await assert.rejects(api.execute(roomId, { ...command, revision: saved.revision }, 'save-new'), {
    code: 'ALREADY_POSTED',
  })
  await assert.rejects(
    api.execute(
      roomId,
      { kind: 'pot', number: saved.ownBalls[0]!.number, potted: true, revision: saved.revision },
      'after-save',
    ),
    { code: 'ALREADY_POSTED' },
  )
})

test('unknown response retries same persisted command after store reload without applying twice', async () => {
  const { api, roomId } = await setup()
  let lose = true
  const uncertain = {
    ...api,
    async execute(...args: Parameters<typeof api.execute>) {
      await api.execute(...args)
      if (lose) {
        lose = false
        throw new RoomApiError('TRANSPORT_UNKNOWN', 'unknown')
      }
    },
  }
  let pending: PendingKill | null = null
  const journal = {
    read: () => pending,
    write(value: PendingKill | null) {
      pending = value
    },
  }
  const first = createKillStore(uncertain, () => 'stable-id', journal)
  await first.open(roomId)
  const before = first.store.getState().snapshot!
  assert.equal(
    await first.submit(roomId, {
      kind: 'pot',
      number: before.ownBalls[0]!.number,
      potted: true,
      revision: before.revision,
    }),
    false,
  )
  assert.equal(first.store.getState().snapshot!.remaining['mock-me'], 5)
  assert.ok(pending)
  const second = createKillStore(uncertain, () => 'must-not-use', journal)
  await second.open(roomId)
  assert.equal(await second.submit(roomId), true)
  assert.equal(second.store.getState().snapshot!.remaining['mock-me'], 4)
  assert.equal(pending, null)
})

test('four-player deal and cloud writes fail explicitly instead of falling back', async () => {
  const { api, roomApi } = await setup()
  const room = await roomApi.createRoom('kill_ball', 'another-room')
  await assert.rejects(
    api.execute(room.roomId, { kind: 'deal', participantIds: ['mock-me', 'a', 'b', 'c'] }, 'four'),
    { code: 'RULE_NOT_CONFIGURED' },
  )
  const { unavailableCloudKillApi } = await import('../features/kill/api')
  await assert.rejects(unavailableCloudKillApi.get(room.roomId), { code: 'RULE_NOT_CONFIGURED' })
})

test('late room snapshot cannot replace current view or reopen a departed view', async () => {
  let release: (() => void) | undefined
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const { api, roomId } = await setup()
  const delayed = {
    ...api,
    async get(id: string) {
      if (id === 'old') await barrier
      return id === roomId ? api.get(id) : null
    },
  }
  const journal = { read: () => null, write() {} }
  const session = createKillStore(delayed, () => 'request', journal)
  const old = session.open('old')
  await session.open(roomId)
  const expected = session.store.getState().snapshot
  release!()
  await old
  assert.equal(session.store.getState().roomId, roomId)
  assert.deepEqual(session.store.getState().snapshot, expected)
  session.leave()
  assert.equal(session.store.getState().snapshot, null)
})
