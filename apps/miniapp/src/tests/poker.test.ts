import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockRoomApi } from '../modules/room-api/mock'
import { createAppStores } from '../stores/create-stores'
import { RoomApiError } from '../modules/room-api/errors'
import { createMockPokerApi, unavailableCloudPokerApi } from '../features/poker/api'
import type { PokerCommand } from '../features/poker/api'
import { createPokerStore } from '../features/poker/store'
import type { PendingPoker } from '../features/poker/store'
import { AA_VALUES, deltaFor } from '../features/poker/model'

async function setup(mode: 'da_a' | 'dui_jia' = 'da_a') {
  let roomData: unknown
  const roomStorage = {
    read: () => structuredClone(roomData),
    write: (value: unknown) => {
      roomData = structuredClone(value)
    },
  }
  const baseRoomApi = createMockRoomApi({ storage: roomStorage, delayMs: 0 })
  const receipt = await baseRoomApi.joinRoom(mode === 'da_a' ? '628389' : '628390', 'join-poker')
  let actor = 'mock-me'
  const roomApi = {
    ...baseRoomApi,
    async getMe() {
      return { userId: actor, displayName: actor === 'mock-me' ? '我' : '小林' }
    },
  }
  let data: unknown
  let fail = false
  const storage = {
    read: () => structuredClone(data),
    write(value: unknown) {
      if (fail) throw new Error('disk failed')
      data = structuredClone(value)
    },
  }
  const api = createMockPokerApi(roomApi, storage)
  let pending: PendingPoker | null = null
  const journal = {
    read: () => pending,
    write(_userId: string, value: PendingPoker | null) {
      pending = value
    },
  }
  let sequence = 0
  const session = createPokerStore(api, () => `poker-${++sequence}`, journal)
  await session.open(receipt.roomId, 'mock-me')
  const snapshot = await api.get(receipt.roomId)
  const command: PokerCommand = {
    mode,
    base: snapshot.base,
    configRevision: snapshot.configRevision,
    direction: 1,
    value: mode === 'da_a' ? 6 : 1,
    mingA: false,
  }
  return {
    api,
    roomApi,
    baseRoomApi,
    roomStorage,
    storage,
    session,
    journal,
    roomId: receipt.roomId,
    command,
    act(id: string) {
      actor = id
    },
    fail(value: boolean) {
      fail = value
    },
  }
}

test('poker creation commits selected base with room and retries original receipt after lost response', async () => {
  const { baseRoomApi, roomStorage } = await setup()
  await baseRoomApi.updateProfile!(
    { displayName: '我', avatarFileId: 'cloud://mock/avatars/mock-me/test.png' },
    'profile-poker',
  )
  const session = createAppStores(baseRoomApi, () => 'create-poker')
  baseRoomApi.loseNextResponse()
  assert.equal(await session.submit('create', 'da_a@5'), null)
  assert.equal(session.mutation.getState().phase, 'unknown')
  assert.equal(await session.submit('create', 'da_a@10'), null)
  const roomId = await session.submit('create', 'da_a@5')
  assert.ok(roomId)
  const room = await createMockRoomApi({ storage: roomStorage, delayMs: 0 }).getRoomSnapshot(roomId)
  assert.equal(room.pokerBase, 5)
  assert.equal(room.memberCount, 1)
  await assert.rejects(baseRoomApi.createPokerRoom!('da_a', 10, 'create-poker'), {
    code: 'CONFLICT',
  })
  await assert.rejects(baseRoomApi.createPokerRoom!('da_a', 2.5, 'custom'), {
    code: 'RULE_NOT_CONFIGURED',
  })
})

test('eight AA keys display correct base and mingA amounts without multiplying displayed values again', () => {
  assert.deepEqual(
    AA_VALUES.map((value) => deltaFor('da_a', 5, { direction: 1, value, mingA: false })),
    [5, 10, 15, 20, 30, 40, 80, 160],
  )
  assert.deepEqual(
    AA_VALUES.map((value) => deltaFor('da_a', 5, { direction: 1, value, mingA: true })),
    [10, 20, 30, 40, 60, 80, 160, 320],
  )
  assert.throws(() => deltaFor('dui_jia', 5, { direction: 1, value: 1, mingA: true }), {
    code: 'INVALID_ARGUMENT',
  })
})

test('selection alone changes no ledger; AA save only changes actor and successful save resets value and mingA', async () => {
  const { session, api, roomId } = await setup()
  session.select({ direction: -1, value: 6, mingA: true })
  assert.equal((await api.get(roomId)).entries.length, 0)
  assert.equal(await session.submit(), true)
  const result = session.store.getState()
  assert.equal(result.snapshot!.totals['mock-me'], -60)
  assert.ok(
    result
      .snapshot!.participants.filter((p) => p.userId !== 'mock-me')
      .every((p) => result.snapshot!.totals[p.userId] === 0),
  )
  assert.deepEqual(result.draft, { direction: -1, value: null, mingA: false })
  assert.equal(result.feedback, '已记 -60分')
  assert.equal(result.snapshot!.entries[0]!.base, 5)
  assert.equal(result.snapshot!.entries[0]!.value, 6)
  assert.equal(result.snapshot!.entries[0]!.mingA, true)
})

test('duijia plus one and minus two save separate personal records and survive adapter reload', async () => {
  const { api, roomApi, storage, roomId, command, act } = await setup('dui_jia')
  await api.save(roomId, command, 'plus')
  await api.save(roomId, { ...command, direction: -1, value: 2 }, 'minus')
  const reloaded = await createMockPokerApi(roomApi, storage).get(roomId)
  assert.equal(reloaded.totals['mock-me'], -5)
  assert.deepEqual(
    reloaded.entries.map((e) => e.delta),
    [-10, 5],
  )
  act('mock-poker-0')
  await api.save(roomId, { ...command, value: 2 }, 'other-player')
  const others = await api.get(roomId)
  assert.equal(others.totals['mock-me'], -5)
  assert.equal(others.totals['mock-poker-0'], 10)
})

test('definitive save failure keeps selection and never changes totals; retry commits once', async () => {
  const { api, session } = await setup()
  session.select({ direction: -1, value: 6, mingA: true })
  api.failNext()
  assert.equal(await session.submit(), false)
  assert.equal(session.store.getState().snapshot!.totals['mock-me'], 0)
  assert.deepEqual(session.store.getState().draft, { direction: -1, value: 6, mingA: true })
  assert.equal(session.store.getState().pending, null)
  assert.equal(await session.submit(), true)
  assert.equal(session.store.getState().snapshot!.totals['mock-me'], -60)
  assert.equal(session.store.getState().snapshot!.entries.length, 1)
})

test('unknown save response restores exact draft/request after reload and cannot double count', async () => {
  const { api, session, journal, roomId } = await setup()
  session.select({ value: 6, mingA: true })
  api.loseNextResponse()
  assert.equal(await session.submit(), false)
  assert.equal(session.store.getState().snapshot!.totals['mock-me'], 0)
  const requestId = session.store.getState().pending!.requestId
  session.select({ value: 1 })
  assert.equal(session.store.getState().draft.value, 6)
  const reloaded = createPokerStore(api, () => 'must-not-use', journal)
  await reloaded.open(roomId, 'mock-me')
  assert.equal(reloaded.store.getState().pending!.requestId, requestId)
  assert.deepEqual(reloaded.store.getState().draft, { direction: 1, value: 6, mingA: true })
  await Promise.all([reloaded.submit(), reloaded.submit()])
  assert.equal(reloaded.store.getState().snapshot!.totals['mock-me'], 60)
  assert.equal(reloaded.store.getState().snapshot!.entries.length, 1)
  assert.equal(reloaded.store.getState().draft.mingA, false)
})

test('durable write failure and stale config cannot change scores; old history keeps original base', async () => {
  const { api, roomId, command, fail } = await setup()
  fail(true)
  await assert.rejects(api.save(roomId, command, 'disk-fail'))
  assert.equal((await api.get(roomId)).entries.length, 0)
  fail(false)
  await assert.rejects(api.save(roomId, { ...command, base: 10 }, 'stale'), {
    code: 'STALE_CONTEXT',
  })
  await api.save(roomId, command, 'good')
  await api.save(roomId, command, 'good')
  assert.equal((await api.get(roomId)).entries[0]!.base, 5)
  await assert.rejects(api.save(roomId, { ...command, direction: -1 }, 'good'), {
    code: 'IDEMPOTENCY_MISMATCH',
  })
})

test('underfilled room blocks scoring and no unconfigured cloud creation falls back to mock', async () => {
  const { baseRoomApi, roomApi, storage } = await setup()
  const receipt = await baseRoomApi.createPokerRoom!('dui_jia', 5, 'small')
  const api = createMockPokerApi(roomApi, storage)
  const snapshot = await api.get(receipt.roomId)
  assert.equal(snapshot.canRecord, false)
  assert.match(snapshot.blockedReason!, /还需3位/)
  await assert.rejects(
    api.save(
      receipt.roomId,
      {
        mode: 'dui_jia',
        base: 5,
        configRevision: snapshot.configRevision,
        direction: 1,
        value: 1,
        mingA: false,
      },
      'blocked',
    ),
    { code: 'FORBIDDEN' },
  )
  const { createPokerRoom: _unavailable, ...cloudLike } = baseRoomApi
  const stores = createAppStores(cloudLike, () => 'no-cloud')
  assert.equal(await stores.submit('create', 'da_a@5'), null)
  assert.equal(stores.mutation.getState().phase, 'failed')
  await assert.rejects(unavailableCloudPokerApi.get(receipt.roomId), {
    code: 'RULE_NOT_CONFIGURED',
  })
})

test('changed roster clears stale choice and out-of-order room read cannot replace current view', async () => {
  const { api, roomId, command } = await setup()
  const snapshot = await api.get(roomId)
  let revision = snapshot.configRevision
  let release: (() => void) | undefined
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const custom = {
    ...api,
    async get(id: string) {
      if (id === 'old') await waiting
      return { ...snapshot, roomId: id, configRevision: revision }
    },
    async save() {
      throw new RoomApiError('STALE_CONTEXT', 'changed')
    },
  }
  const session = createPokerStore(custom, () => 'request', { read: () => null, write() {} })
  await session.open(roomId, 'mock-me')
  session.select({ value: command.value })
  revision++
  await session.open(roomId, 'mock-me')
  assert.equal(session.store.getState().draft.value, null)
  const old = session.open('old', 'mock-me')
  await session.open(roomId, 'mock-me')
  release!()
  await old
  assert.equal(session.store.getState().snapshot!.roomId, roomId)
  session.leave()
  assert.equal(session.store.getState().snapshot, null)
})
