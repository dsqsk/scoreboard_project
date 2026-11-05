import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockRoomApi } from '../modules/room-api/mock'
import { createCloudRoomApi } from '../modules/room-api/cloud'
import { createRecentStore } from '../features/recent/store'
import type { RecentOperation } from '../features/recent/store'
import { beginSwipe, moveSwipe, endSwipe } from '../features/recent/gesture'
import { enterRoomOnce } from '../features/recent/visit'
import { RoomApiError } from '../modules/room-api/errors'
import type { RoomPreview } from '../modules/room-api/types'
const room = (id: string): RoomPreview => ({
  roomId: id,
  name: id,
  joinCode: '123456',
  memberCount: 2,
  status: 'active',
  selectedMode: 'point_ball',
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function mockSetup() {
  let data: unknown
  const storage = {
    read: () => structuredClone(data),
    write(value: unknown) {
      data = structuredClone(value)
    },
  }
  const api = createMockRoomApi({ storage, delayMs: 0 })
  const ids: string[] = []
  for (let i = 0; i < 26; i++)
    ids.push((await api.createRoom('point_ball', `recent-create-${i}`)).roomId)
  return { api, ids, storage }
}
test('Mock hides persistently without leaving; snapshots do not restore/reorder; explicit enter/join restore once', async () => {
  const { api, ids, storage } = await mockSetup()
  const first = ids[0]!
  for (const [i, id] of ids.slice(2).entries())
    await api.dismissRecentRoom(id, `recent-dismiss-${i}`)
  assert.deepEqual(
    (await api.listRecentPage()).rooms.map((r) => r.roomId),
    [ids[1], first],
  )
  const snapshot = await api.getRoomSnapshot(ids[25]!)
  assert.equal(snapshot.members.length, 1)
  const fresh = createMockRoomApi({ storage, delayMs: 0 })
  assert.equal((await fresh.listRecentPage()).rooms.length, 2)
  await fresh.enterRoom(ids[25]!, 'recent-explicit-enter')
  const before = (await fresh.listRecentPage()).rooms[0]!
  await fresh.getRoomSnapshot(first)
  assert.deepEqual((await fresh.listRecentPage()).rooms[0], before)
  await fresh.dismissRecentRoom(ids[25]!, 'recent-hide-again')
  await fresh.enterRoom(ids[25]!, 'recent-explicit-enter')
  assert.equal(
    (await fresh.listRecentPage()).rooms.some((r) => r.roomId === ids[25]),
    false,
  )
  await fresh.joinRoom(snapshot.joinCode, 'recent-rejoin-new')
  assert.equal((await fresh.listRecentPage()).rooms[0]!.roomId, ids[25])
  assert.equal((await fresh.getRoomSnapshot(ids[25]!)).members.length, 1)
})
test('recent controller follows empty scan pages, deduplicates, and refills after dismiss', async () => {
  let hidden = false
  const calls: (string | undefined)[] = []
  const session = createRecentStore({
    owner: async () => 'A',
    makeId: () => 'dismiss-one',
    enter: async () => {},
    dismiss: async () => {
      hidden = true
    },
    list: async (cursor) => {
      calls.push(cursor)
      return cursor === undefined
        ? { rooms: [], nextCursor: 'scan-one' }
        : cursor === 'scan-one'
          ? { rooms: [], nextCursor: 'scan-two' }
          : { rooms: (hidden ? ['B', 'C', 'D'] : ['A', 'B', 'C', 'C']).map(room), nextCursor: null }
    },
  })
  await session.load()
  assert.deepEqual(
    session.store.getState().rooms.map((r) => r.roomId),
    ['A', 'B', 'C'],
  )
  assert.deepEqual(calls, [undefined, 'scan-one', 'scan-two'])
  assert.equal(await session.run('dismiss', 'A'), true)
  assert.deepEqual(
    session.store.getState().rooms.map((r) => r.roomId),
    ['B', 'C', 'D'],
  )
})
test('dismiss pending retains original card; unknown restores same request and preview across restart', async () => {
  const response = deferred<void>()
  const sent: string[] = []
  let saved: RecentOperation | null = null
  let hidden = false
  const ports = {
    owner: async () => 'A',
    makeId: () => 'original-dismiss',
    journal: {
      read: () => saved,
      write(_id: string, value: RecentOperation | null) {
        saved = value
      },
    },
    enter: async () => {},
    dismiss: async (_id: string, requestId: string) => {
      sent.push(requestId)
      if (sent.length === 1) {
        await response.promise
        hidden = true
        throw new RoomApiError('TRANSPORT_UNKNOWN', 'lost')
      }
    },
    list: async () => ({ rooms: hidden ? [] : [room('A')], nextCursor: null }),
  }
  const s = createRecentStore(ports)
  await s.load()
  const deleting = s.run('dismiss', 'A')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(s.store.getState().rooms.length, 1)
  assert.equal(await s.run('dismiss', 'A'), false)
  response.resolve()
  assert.equal(await deleting, false)
  assert.equal(s.store.getState().phase, 'unknown')
  await s.load()
  assert.equal(s.store.getState().rooms.length, 1)
  const reload = createRecentStore(ports)
  await reload.load()
  assert.equal(reload.store.getState().rooms[0]!.roomId, 'A')
  assert.equal(await reload.run('enter', 'other'), false)
  assert.equal(await reload.recover(), true)
  assert.deepEqual(sent, ['original-dismiss', 'original-dismiss'])
  assert.equal(reload.store.getState().rooms.length, 0)
  assert.equal(saved, null)
})
test('late list and mutation errors cannot overwrite a different identity; corrupt journals remain blocked', async () => {
  let owner = 'A'
  const response = deferred<void>()
  const s = createRecentStore({
    owner: async () => owner,
    makeId: () => 'A-request',
    enter: async () => {},
    dismiss: async () => response.promise,
    list: async () => ({ rooms: [room(owner)], nextCursor: null }),
  })
  await s.load()
  const pending = s.run('dismiss', 'A')
  await Promise.resolve()
  await Promise.resolve()
  owner = 'B'
  await s.load()
  response.reject(new RoomApiError('INTERNAL_ERROR', 'A failed'))
  await pending
  assert.deepEqual(
    s.store.getState().rooms.map((r) => r.roomId),
    ['B'],
  )
  assert.equal(s.store.getState().operation, null)
  assert.equal(s.store.getState().phase, 'idle')
  let writes = 0
  const broken = createRecentStore({
    owner: async () => 'B',
    makeId: () => 'new',
    list: async () => ({ rooms: [], nextCursor: null }),
    enter: async () => {
      writes++
    },
    dismiss: async () => {
      writes++
    },
    journal: {
      read() {
        throw new Error('corrupt journal')
      },
      write() {},
    },
  })
  await broken.load()
  await broken.run('enter', 'B')
  await broken.run('dismiss', 'B')
  assert.equal(writes, 0)
  assert.match(broken.store.getState().error!, /corrupt/)
})
test('late list success does not resurrect a confirmed dismiss', async () => {
  const old = deferred<{ rooms: RoomPreview[]; nextCursor: null }>()
  let calls = 0
  const s = createRecentStore({
    owner: async () => 'A',
    makeId: () => 'one',
    enter: async () => {},
    dismiss: async () => {},
    list: async () => (++calls === 1 ? old.promise : { rooms: [room('B')], nextCursor: null }),
  })
  const load = s.load()
  await Promise.resolve()
  await Promise.resolve()
  await s.run('dismiss', 'A')
  old.resolve({ rooms: [room('A')], nextCursor: null })
  await load
  assert.deepEqual(
    s.store.getState().rooms.map((r) => r.roomId),
    ['B'],
  )
})
test('swipe direction preserves vertical scroll, suppresses accidental taps, and uses half-width threshold', () => {
  const horizontal = moveSwipe(beginSwipe(200, 100, false), 130, 105)
  assert.deepEqual(endSwipe(horizontal), { opened: true, suppressClick: true })
  const vertical = moveSwipe(beginSwipe(200, 100, false), 195, 150)
  assert.equal(vertical.direction, 'vertical')
  assert.equal(vertical.offset, 0)
  assert.equal(endSwipe(moveSwipe(beginSwipe(200, 100, true), 260, 100)).opened, false)
  assert.equal(endSwipe(moveSwipe(beginSwipe(200, 100, false), 170, 100)).opened, false)
})
test('one page visit enters once across rerenders, background show and profile remount; new navigation enters again', async () => {
  let calls = 0
  const marker = { current: false }
  const enter = async () => {
    calls++
    return true
  }
  await Promise.all([enterRoomOnce(marker, enter), enterRoomOnce(marker, enter)])
  await enterRoomOnce(marker, enter)
  assert.equal(calls, 1)
  await enterRoomOnce({ current: false }, enter)
  assert.equal(calls, 2)
})
test('explicit recovery confirmation overrides an earlier blocked page entry without another write', async () => {
  const visit: { current: boolean; confirmed?: boolean } = { current: false }
  assert.equal(await enterRoomOnce(visit, async () => false), false)
  visit.confirmed = true
  assert.equal(
    await enterRoomOnce(visit, async () => {
      throw new Error('must not write again')
    }),
    true,
  )
})
test('cloud recent adapter preserves empty page cursor and validates explicit writes', async () => {
  const requests: string[] = []
  const api = createCloudRoomApi('env', {
    init() {},
    async call(req) {
      requests.push(req.action)
      return {
        ok: true,
        data:
          req.action === 'room.listRecentPage'
            ? { rooms: [], nextCursor: 'opaque_cursor' }
            : { requestId: 'request-original', roomId: 'room-A', entityId: 'room-A' },
      }
    },
  })
  assert.deepEqual(await api.listRecentPage(), { rooms: [], nextCursor: 'opaque_cursor' })
  await api.enterRoom('room-A', 'request-original')
  await api.dismissRecentRoom('room-A', 'request-original')
  assert.deepEqual(requests, ['room.listRecentPage', 'room.enter', 'room.dismissRecent'])
})

test('known dismiss failure keeps card and can retry; original unknown dismiss can precede a new explicit enter', async () => {
  let failed = true
  let visible = true
  const writes: string[] = []
  const session = createRecentStore({
    owner: async () => 'A',
    makeId: () => `write-${writes.length}`,
    list: async () => ({ rooms: visible ? [room('R')] : [], nextCursor: null }),
    dismiss: async () => {
      writes.push('dismiss')
      if (failed) {
        failed = false
        throw new RoomApiError('INTERNAL_ERROR', 'server failed')
      }
      visible = false
    },
    enter: async () => {
      writes.push('enter')
      visible = true
    },
  })
  await session.load()
  assert.equal(await session.run('dismiss', 'R'), false)
  assert.equal(session.store.getState().rooms.length, 1)
  assert.equal(session.store.getState().phase, 'failed')
  assert.equal(await session.recover(), true)
  assert.equal(session.store.getState().rooms.length, 0)
  assert.equal(await session.run('enter', 'R'), true)
  assert.equal(session.store.getState().rooms[0]!.roomId, 'R')
})
test('late mutation success and late list rejection leave the new identity untouched', async () => {
  let owner = 'A'
  const mutation = deferred<void>()
  const s = createRecentStore({
    owner: async () => owner,
    makeId: () => 'A-enter',
    enter: async () => mutation.promise,
    dismiss: async () => {},
    list: async () => ({ rooms: [room(owner)], nextCursor: null }),
  })
  await s.load()
  const enter = s.run('enter', 'A')
  await Promise.resolve()
  await Promise.resolve()
  owner = 'B'
  await s.load()
  mutation.resolve()
  await enter
  assert.deepEqual(
    s.store.getState().rooms.map((r) => r.roomId),
    ['B'],
  )
  assert.equal(s.store.getState().operation, null)
  let actor = 'A'
  const old = deferred<{ rooms: RoomPreview[]; nextCursor: null }>()
  const lists = createRecentStore({
    owner: async () => actor,
    makeId: () => 'unused',
    enter: async () => {},
    dismiss: async () => {},
    list: async () => (actor === 'A' ? old.promise : { rooms: [room('B')], nextCursor: null }),
  })
  const loading = lists.load()
  await Promise.resolve()
  await Promise.resolve()
  actor = 'B'
  await lists.load()
  old.reject(new Error('old A read failed'))
  await loading
  assert.equal(lists.store.getState().error, null)
  assert.deepEqual(
    lists.store.getState().rooms.map((r) => r.roomId),
    ['B'],
  )
})
