import './http.test'
import './page-reads.test'
import './da-a.test'
import './recent.test'
import './profile.test'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockRoomApi } from '../modules/room-api/mock'
import { createAppStores } from '../stores/create-stores'
import type { RoomApi, RoomSnapshot } from '../modules/room-api/types'
import type { PendingCommand } from '../stores/create-stores'

function setup() {
  let persisted: unknown
  const storage = {
    read: () => persisted,
    write(value: unknown) {
      persisted = structuredClone(value)
    },
  }
  const mock = createMockRoomApi({ storage, delayMs: 0 })
  const api = {
    ...mock,
    async getMe() {
      return { ...(await mock.getMe()), profileCompleted: true }
    },
  }
  let sequence = 0
  let pending: PendingCommand | null = null
  const pendingStorage = {
    read: () => pending,
    write(value: PendingCommand | null) {
      pending = value
    },
  }
  const stores = createAppStores(api, () => `request-${++sequence}`, pendingStorage)
  return { api, storage, stores, pendingStorage }
}

test('no pre-created recent rooms; creation preserves mode and persists across reload', async () => {
  const { api, storage } = setup()
  assert.deepEqual(await api.listRecent(), [])
  const receipt = await api.createRoom('da_a', 'create-one')
  const reload = createMockRoomApi({ storage, delayMs: 0 })
  const room = await reload.getRoomSnapshot(receipt.roomId)
  assert.equal(room.selectedMode, 'da_a')
  assert.equal(room.memberCount, 1)
  assert.equal(room.activeActivityId, null)
  assert.equal((await reload.listRecent()).length, 1)
})

test('same create request concurrent/retried creates one room; changed payload rejected', async () => {
  const { api } = setup()
  const [a, b] = await Promise.all([
    api.createRoom('kill_ball', 'same-id'),
    api.createRoom('kill_ball', 'same-id'),
  ])
  assert.deepEqual(a, b)
  assert.equal((await api.listRecent()).length, 1)
  await assert.rejects(api.createRoom('da_a', 'same-id'), /该请求已用于其他操作/)
})

test('preview exposes no member details; duplicate join does not duplicate identity', async () => {
  const { api } = setup()
  const preview = await api.previewRoom('628391')
  assert.equal('members' in preview, false)
  assert.equal(preview.memberCount, 2)
  const a = await api.joinRoom('628391', 'join-first')
  await api.joinRoom('628391', 'join-second')
  const snapshot = await api.getRoomSnapshot(a.roomId)
  assert.equal(snapshot.memberCount, 3)
  assert.equal(snapshot.members.filter((member) => member.userId === 'mock-me').length, 1)
})

test('not-found and not-member requests fail; neither adds a recent room', async () => {
  const { api } = setup()
  await assert.rejects(api.previewRoom('000000'), /未找到/)
  await assert.rejects(api.getRoomSnapshot('mock-example'), /请先加入/)
  assert.deepEqual(await api.listRecent(), [])
})

test('failed durable write never returns a successful created room', async () => {
  const api = createMockRoomApi({
    delayMs: 0,
    storage: {
      read: () => null,
      write() {
        throw new Error('storage failed')
      },
    },
  })
  await assert.rejects(api.createRoom('kill_ball', 'failed-write'), /storage failed/)
  // Identity assignment also persists now; unavailable storage must not report success.
  await assert.rejects(api.listRecent(), /storage failed/)
})

test('store guards double click synchronously and retries failed request', async () => {
  const { stores, api } = setup()
  await stores.ensureIdentity()
  api.failNext()
  assert.equal(await stores.submit('create', 'point_ball'), null)
  assert.equal(stores.mutation.getState().phase, 'failed')
  const first = stores.submit('create', 'point_ball')
  assert.equal(await stores.submit('create', 'point_ball'), null)
  assert.ok(await first)
  assert.equal((await api.listRecent()).length, 1)
})

test('lost successful response keeps the original request on recovery, even after restart', async () => {
  const { stores, api, pendingStorage } = setup()
  await stores.ensureIdentity()
  api.loseNextResponse()
  assert.equal(await stores.submit('create', 'kill_ball'), null)
  assert.equal(stores.mutation.getState().phase, 'unknown')
  const original = stores.mutation.getState().command?.requestId
  const restored = createAppStores(api, () => 'must-not-use-new-id', pendingStorage)
  await restored.restorePending()
  assert.equal(restored.mutation.getState().phase, 'unknown')
  assert.equal(await restored.submit('create', 'da_a'), null)
  assert.ok(await restored.submit('create', 'kill_ball'))
  assert.equal(restored.mutation.getState().command?.requestId, original)
  assert.equal((await api.listRecent()).length, 1)
})

test('late snapshot from a previous room cannot replace current session or cleared session', async () => {
  const { api } = setup()
  const first = await api.createRoom('kill_ball', 'first')
  const second = await api.createRoom('point_ball', 'second')
  let resolveFirst!: (snapshot: RoomSnapshot) => void
  const oldSnapshot = await api.getRoomSnapshot(first.roomId)
  const delayed: RoomApi = {
    ...api,
    getRoomSnapshot: (id) =>
      id === first.roomId
        ? new Promise((resolve) => {
            resolveFirst = resolve
          })
        : api.getRoomSnapshot(id),
  }
  const stores = createAppStores(delayed, () => 'unused')
  await stores.ensureIdentity()
  const pending = stores.openRoom(first.roomId)
  await stores.openRoom(second.roomId)
  resolveFirst(oldSnapshot)
  await pending
  assert.equal(stores.room.getState().snapshot?.roomId, second.roomId)
  const another = stores.openRoom(first.roomId)
  await Promise.resolve()
  stores.leaveView()
  resolveFirst(oldSnapshot)
  await another
  assert.equal(stores.room.getState().snapshot, null)
})

test('cloud Adapter follows shared request contract and normalizes paginated snapshot', async () => {
  const { createCloudRoomApi } = await import('../modules/room-api/cloud')
  const requests: string[] = []
  const room = {
    roomId: 'real-room',
    name: '朋友房间',
    joinCode: '123456',
    selectedMode: 'kill_ball',
    memberCount: 2,
    status: 'active',
  }
  const api = createCloudRoomApi('test-env', {
    init(env) {
      assert.equal(env, 'test-env')
    },
    async call(request) {
      requests.push(request.action)
      if (request.action === 'room.listRecent')
        return { ok: true, data: [{ ...room, displayName: '服务端冗余字段' }] }
      if (request.action === 'room.getSnapshot')
        return {
          ok: true,
          data: {
            ...room,
            revision: 2,
            activeActivityId: null,
            signalDocumentId: 'private-signal',
            members: [{ userId: 'one', displayName: '甲', joinedAt: '2026-10-21T00:00:00.000Z' }],
            membersNextCursor: 'cursor-one',
          },
        }
      if (request.action === 'room.listMembers') {
        assert.equal(request.payload.cursor, 'cursor-one')
        return {
          ok: true,
          data: {
            members: [{ userId: 'two', displayName: '乙', joinedAt: '2026-10-21T00:00:00.000Z' }],
            nextCursor: null,
          },
        }
      }
      throw new Error('unexpected action')
    },
  })
  assert.equal((await api.listRecent())[0].joinCode, '123456')
  const snapshot = await api.getRoomSnapshot('real-room')
  assert.equal(snapshot.members.length, 2)
  assert.equal('signalDocumentId' in snapshot, false)
  assert.deepEqual(requests, ['room.listRecent', 'room.getSnapshot', 'room.listMembers'])
})

test('cloud transport loss and malformed write response cannot report a successful room', async () => {
  const { createCloudRoomApi } = await import('../modules/room-api/cloud')
  const lost = createCloudRoomApi('env', {
    init() {},
    async call() {
      throw new Error('connection lost')
    },
  })
  await assert.rejects(
    lost.createRoom('kill_ball', 'request-unknown'),
    (error) => error instanceof Error && 'code' in error && error.code === 'TRANSPORT_UNKNOWN',
  )
  const malformed = createCloudRoomApi('env', {
    init() {},
    async call() {
      return { ok: true, data: { roomId: 'room', requestId: 'different-request' } }
    },
  })
  await assert.rejects(
    malformed.createRoom('kill_ball', 'request-original'),
    (error) => error instanceof Error && 'code' in error && error.code === 'INVALID_RESPONSE',
  )
})

test('cloud business errors are preserved and invalid room DTO is rejected', async () => {
  const { createCloudRoomApi } = await import('../modules/room-api/cloud')
  const forbidden = createCloudRoomApi('env', {
    init() {},
    async call() {
      return { ok: false, error: { code: 'FORBIDDEN', message: '无权访问' } }
    },
  })
  await assert.rejects(forbidden.getRoomSnapshot('room'), /无权访问/)
  const malformed = createCloudRoomApi('env', {
    init() {},
    async call() {
      return { ok: true, data: [{ roomId: 'bad' }] }
    },
  })
  await assert.rejects(malformed.listRecent(), /最近房间返回异常/)
})

import './kill.test'

import './poker.test'

import './point.test'
