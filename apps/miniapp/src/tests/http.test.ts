import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FoundationRequest } from '@scoreboard/shared'
import { createHttpTransport } from '../platform/http'
import type { HttpResponse, HttpPorts } from '../platform/http'
import { createCloudRoomApi } from '../modules/room-api/cloud'
import { createCloudPointApi } from '../features/point/cloud'
import { createCloudDaAApi } from '../features/da-a/api'
import { createMockRoomApi } from '../modules/room-api/mock'
import { createMockPointApi } from '../features/point/api'
import type { PointCommand } from '../features/point/api'
import { createPointStore } from '../features/point/store'
import type { PointOperation } from '../features/point/store'
const request: FoundationRequest = {
  action: 'room.join',
  requestId: 'original-id',
  payload: { joinCode: '123456' },
}
const auth = (token = 'token'): HttpResponse => ({
  statusCode: 200,
  data: { ok: true, data: { accessToken: token, expiresAt: 2000 } },
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

test('HTTP concurrent callers share login and send unchanged DTOs with only bearer credentials', async () => {
  const login = deferred<{ code: string }>()
  let logins = 0
  const calls: Parameters<HttpPorts['request']>[0][] = []
  const http = createHttpTransport('https://api.example.test/', {
    now: () => 0,
    login() {
      logins++
      return login.promise
    },
    async request(input) {
      calls.push(input)
      return input.url.endsWith('/auth/wechat')
        ? auth()
        : { statusCode: 200, data: { ok: true, data: 'saved' } }
    },
  })
  const first = http.call(request),
    second = http.call(request)
  assert.equal(logins, 1)
  login.resolve({ code: 'wx-code' })
  await Promise.all([first, second])
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0]!.data, { code: 'wx-code' })
  assert.deepEqual(calls[0]!.header, { 'content-type': 'application/json' })
  for (const call of calls.slice(1)) {
    assert.equal(call.url, 'https://api.example.test/api')
    assert.equal(call.header.Authorization, 'Bearer token')
    assert.equal(call.data, request)
  }
})

test('401 renews once, delayed old 401 cannot evict newer session, and second 401 stops', async () => {
  let logins = 0,
    auths = 0
  const delayed = deferred<HttpResponse>()
  let oldCalls = 0
  const http = createHttpTransport('https://api.example.test', {
    now: () => 0,
    async login() {
      return { code: `code-${++logins}` }
    },
    async request(input) {
      if (input.url.endsWith('/auth/wechat')) return auth(`token-${++auths}`)
      if (input.header.Authorization === 'Bearer token-1')
        return ++oldCalls === 1 ? delayed.promise : { statusCode: 401, data: {} }
      return { statusCode: 200, data: { ok: true, data: 'ok' } }
    },
  })
  const first = http.call(request)
  // Wait for the first API request rather than depending on arbitrary timer timing.
  while (!oldCalls) await Promise.resolve()
  assert.deepEqual(await http.call(request), { ok: true, data: 'ok' })
  delayed.resolve({ statusCode: 401, data: {} })
  assert.deepEqual(await first, { ok: true, data: 'ok' })
  assert.equal(logins, 2)
  const seen: unknown[] = []
  let loginCount = 0
  const rejected = createHttpTransport('https://api.example.test', {
    now: () => 0,
    async login() {
      loginCount++
      return { code: 'code' }
    },
    async request(input) {
      if (input.url.endsWith('/auth/wechat')) return auth()
      seen.push(input.data)
      return { statusCode: 401, data: {} }
    },
  })
  const result = await rejected.call(request)
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'UNAUTHENTICATED', message: '登录已失效，请重试' },
  })
  assert.equal(loginCount, 2)
  assert.deepEqual(seen, [request, request])
})

test('expiry renews; failed login is retryable; transport loss has no automatic replay', async () => {
  let time = 0,
    logins = 0,
    apiCalls = 0,
    failLogin = true
  const http = createHttpTransport('https://api.example.test', {
    now: () => time,
    async login() {
      logins++
      if (failLogin) throw new Error('login unavailable')
      return { code: 'code' }
    },
    async request(input) {
      if (input.url.endsWith('/auth/wechat'))
        return {
          ...auth(),
          data: { ok: true, data: { accessToken: 'token', expiresAt: time + 2000 } },
        }
      apiCalls++
      throw new Error('connection lost')
    },
  })
  await assert.rejects(http.call(request))
  failLogin = false
  await assert.rejects(http.call(request))
  assert.equal(logins, 2)
  assert.equal(apiCalls, 1)
  await assert.rejects(http.call(request))
  assert.equal(logins, 2)
  time = 2000
  await assert.rejects(http.call(request))
  assert.equal(logins, 3)
  assert.equal(apiCalls, 3)
})

test('HTTP URL checks forbid credentials/query/path/insecure production; dev override is explicit', async () => {
  let calls = 0
  const ports: HttpPorts = {
    async login() {
      calls++
      return { code: 'code' }
    },
    async request() {
      calls++
      return auth()
    },
    now: () => 0,
  }
  for (const base of [
    '',
    'http://127.0.0.1:3000',
    'https://user:pass@api.test',
    'https://api.test/path',
    'https://api.test?secret=x',
  ])
    await assert.rejects(createHttpTransport(base, ports).call(request))
  assert.equal(calls, 0)
  createHttpTransport('http://127.0.0.1:3000', ports, true).init()
})

test('maintenance is recognized across room/profile/recent, point and daA without cloud fallback', async () => {
  let apiCalls = 0
  const http = createHttpTransport('https://api.example.test', {
    now: () => 0,
    async login() {
      return { code: 'code' }
    },
    async request(input) {
      if (input.url.endsWith('/auth/wechat')) return auth()
      apiCalls++
      return { statusCode: 503, data: 'maintenance' }
    },
  })
  const rooms = createCloudRoomApi('http', http),
    point = createCloudPointApi('http', http),
    daa = createCloudDaAApi(http.call)
  for (const operation of [
    () => rooms.getMe(),
    () => rooms.updateProfile!({ displayName: '昵称' }, 'profile-id'),
    () => rooms.listRecentPage!(undefined),
    () => point.get('room'),
    () => daa.get('room'),
  ])
    await assert.rejects(operation(), { code: 'MAINTENANCE' })
  assert.equal(apiCalls, 5)
  const unavailable = createHttpTransport('https://api.example.test', {
    async login() {
      return { code: 'code' }
    },
    async request() {
      return { statusCode: 503, data: null }
    },
  })
  await assert.rejects(createCloudRoomApi('http', unavailable).getMe(), { code: 'MAINTENANCE' })
})

test('HTTP point maintenance and lost successful response retain original ID and recover without duplicate score', async () => {
  let roomData: unknown, pointData: unknown
  const rooms = createMockRoomApi({
    delayMs: 0,
    storage: {
      read: () => roomData,
      write: (v) => {
        roomData = structuredClone(v)
      },
    },
  })
  const { roomId } = await rooms.joinRoom('628388', 'http-join')
  const api = createMockPointApi(rooms, {
    read: () => pointData,
    write: (v) => {
      pointData = structuredClone(v)
    },
  })
  const initial = await api.get(roomId)
  const participantIds = (await rooms.getRoomSnapshot(roomId)).members
    .slice(0, 3)
    .map((m) => m.userId)
  await api.execute(
    roomId,
    { kind: 'prepare', expectedRoomRevision: initial.roomRevision, participantIds },
    'http-prepare',
  )
  let mode: 'maintenance' | 'lost' | 'ready' = 'maintenance'
  const writes: string[] = []
  const http = createHttpTransport('https://api.example.test', {
    now: () => 0,
    async login() {
      return { code: 'code' }
    },
    async request(input) {
      if (input.url.endsWith('/auth/wechat')) return auth()
      const data = input.data as FoundationRequest
      if (data.action === 'point.getState')
        return { statusCode: 200, data: { ok: true, data: await api.get(roomId) } }
      if (mode === 'maintenance') return { statusCode: 503, data: null }
      assert.equal(data.action, 'point.claim')
      if (data.action !== 'point.claim') throw new Error('unexpected action')
      writes.push(data.requestId)
      const value = await api.execute(
        roomId,
        {
          kind: 'claim',
          activityId: data.payload.activityId,
          number: data.payload.number,
          expectedCardRevision: data.payload.expectedCardRevision,
        },
        data.requestId,
      )
      if (mode === 'lost') throw new Error('response lost after commit')
      return { statusCode: 200, data: { ok: true, data: value } }
    },
  })
  let pending: PointOperation[] = [],
    serial = 0,
    time = 0
  const session = createPointStore(
    createCloudPointApi('http', http),
    () => `http-operation-${++serial}`,
    {
      read: () => pending,
      write: (_id, v) => {
        pending = structuredClone(v)
      },
    },
    () => time,
  )
  await session.open(roomId, 'mock-me')
  const command: PointCommand = {
    kind: 'claim',
    activityId: session.store.getState().snapshot!.activity!.activityId,
    number: 6,
    expectedCardRevision: 0,
  }
  assert.equal(await session.submit(command), false)
  assert.match(session.store.getState().error!, /维护/)
  assert.equal(pending[0]!.requestId, 'http-operation-1')
  mode = 'lost'
  time = 400
  await session.recover()
  assert.equal(pending.length, 1)
  assert.equal(session.store.getState().snapshot!.activity!.earnedPoints['mock-me'], 0)
  mode = 'ready'
  time = 800
  await session.recover()
  assert.equal(pending.length, 0)
  assert.equal(serial, 1)
  assert.deepEqual(writes, ['http-operation-1', 'http-operation-1'])
  assert.equal(session.store.getState().snapshot!.activity!.earnedPoints['mock-me'], 6)
})

test('HTTP avatars upload raw bytes, validate ownership and cache/renew signed URLs while preserving legacy IDs', async () => {
  const { createHttpAvatars } = await import('../features/profile/http-avatars')
  const userId = `usr_${'a'.repeat(64)}`
  const fileId = `avatar:v1:${userId}:${'b'.repeat(32)}.png`
  let time = 0,
    reads = 0
  const bytes = new Uint8Array([137, 80, 78, 71]).buffer
  const avatars = createHttpAvatars(
    async (path, data, type) => {
      if (path === '/avatars') {
        assert.equal(data, bytes)
        assert.equal(type, 'image/png')
        return { ok: true, data: { avatarFileId: fileId } }
      }
      reads++
      const id = (data as { fileIds: string[] }).fileIds[0]!
      return {
        ok: true,
        data:
          id === 'cloud://unmapped'
            ? { urls: {}, unavailable: [id] }
            : {
                urls: { [id]: `https://images.example.test/content?signature=opaque-${reads}` },
                unavailable: [],
              },
      }
    },
    () => time,
  )
  assert.equal(await avatars.upload(userId, bytes, 'image/png'), fileId)
  await assert.rejects(avatars.upload(userId, bytes, 'text/html'))
  await assert.rejects(avatars.upload(userId, new ArrayBuffer(2 * 1024 * 1024 + 1), 'image/png'))
  const first = await avatars.resolve('cloud://legacy')
  assert.match(first!, /^https:/)
  assert.equal(await avatars.resolve('cloud://legacy'), first)
  assert.equal(reads, 1)
  const renewed = await avatars.resolve('cloud://legacy', true)
  assert.notEqual(renewed, first)
  time = 56 * 60 * 1000
  assert.notEqual(await avatars.resolve('cloud://legacy'), renewed)
  assert.equal(await avatars.resolve('cloud://unmapped'), undefined)
  const wrong = createHttpAvatars(async () => ({
    ok: true,
    data: { avatarFileId: fileId.replace(userId, `usr_${'c'.repeat(64)}`) },
  }))
  await assert.rejects(wrong.upload(userId, bytes, 'image/png'))
  const insecure = createHttpAvatars(async () => ({
    ok: true,
    data: { urls: { [fileId]: 'http://images.example.test/x' }, unavailable: [] },
  }))
  await assert.rejects(insecure.resolve(fileId))
})

test('profile HTTP avatar reference remains durable through unknown result and retry without reupload', async () => {
  const { createProfileStore } = await import('../features/profile/store')
  const userId = `usr_${'a'.repeat(64)}`
  const fileId = `avatar:v1:${userId}:${'b'.repeat(32)}.png`
  let uploads = 0,
    unknown = true,
    pending: import('../features/profile/store').ProfilePending | null = null
  const ids: string[] = []
  const profile = createProfileStore({
    makeId: () => 'profile-http-request',
    async upload() {
      uploads++
      return fileId
    },
    async update(input, id) {
      assert.equal(input.avatarFileId, fileId)
      ids.push(id)
      if (unknown) throw new Error('lost')
    },
    async reload() {
      return { userId, displayName: '开心的狗', avatarFileId: fileId, profileCompleted: true }
    },
    read: () => pending,
    write: (_id, value) => {
      pending = value
    },
  })
  profile.open({
    userId,
    displayName: '默认昵称',
    avatarFileId: null,
    defaultAvatar: { template: 'person-v1', color: '#8899aa' },
    profileCompleted: false,
  })
  profile.name('开心的狗')
  profile.choose('/local/avatar.png')
  assert.equal(await profile.save(), false)
  assert.equal(profile.store.getState().phase, 'unknown')
  unknown = false
  assert.equal(await profile.save(), true)
  assert.equal(uploads, 1)
  assert.deepEqual(ids, ['profile-http-request', 'profile-http-request'])
  assert.equal(profile.store.getState().avatar, fileId)
})

test('HTTP profile DTO accepts durable server avatar reference before transport', async () => {
  const userId = `usr_${'a'.repeat(64)}`,
    avatarFileId = `avatar:v1:${userId}:${'b'.repeat(32)}.png`
  const calls: FoundationRequest[] = []
  const http = createHttpTransport('https://api.example.test', {
    now: () => 0,
    async login() {
      return { code: 'code' }
    },
    async request(input) {
      if (input.url.endsWith('/auth/wechat')) return auth()
      const data = input.data as FoundationRequest
      calls.push(data)
      return {
        statusCode: 200,
        data: { ok: true, data: { requestId: 'http-avatar-profile', entityId: userId } },
      }
    },
  })
  await createCloudRoomApi('http', http).updateProfile!(
    { displayName: '开心的狗', avatarFileId },
    'http-avatar-profile',
  )
  assert.deepEqual(calls, [
    {
      action: 'identity.updateProfile',
      requestId: 'http-avatar-profile',
      payload: { displayName: '开心的狗', avatarFileId },
    },
  ])
})
