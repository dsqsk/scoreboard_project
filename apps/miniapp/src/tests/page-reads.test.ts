import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRoomReadLifecycle } from '../features/room/read-lifecycle'
import { createPointNetworkHandler } from '../features/point/network'
import { createAppStores } from '../stores/create-stores'
import { createMockRoomApi } from '../modules/room-api/mock'
import type { RoomSnapshot } from '../modules/room-api/types'

test('mount and initial show issue exactly one real room API read in either order', async () => {
  for (const showFirst of [false, true]) {
    let data: unknown
    const api = createMockRoomApi({
      delayMs: 0,
      storage: {
        read: () => data,
        write(value) {
          data = value
        },
      },
    })
    const roomId = (await api.createRoom('point_ball', 'read-lifecycle-create')).roomId
    let calls = 0
    const stores = createAppStores(
      {
        ...api,
        async getRoomSnapshot(id) {
          calls++
          return api.getRoomSnapshot(id)
        },
      },
      () => 'unused',
    )
    const pending: Promise<void>[] = []
    const page = createRoomReadLifecycle(
      (id) => {
        pending.push(stores.openRoom(id))
      },
      () => stores.leaveView(),
    )
    if (showFirst) {
      page.show(roomId)
      page.mount(roomId)
    } else {
      page.mount(roomId)
      page.show(roomId)
    }
    await Promise.all(pending)
    assert.equal(calls, 1)
    assert.equal(stores.room.getState().status, 'ready')
    // Even if initial onShow arrives after the request has already completed, it is one cycle.
    page.show(roomId)
    page.mount(roomId)
    await Promise.all(pending)
    assert.equal(calls, 1)
    page.hide()
    page.show(roomId)
    await Promise.all(pending)
    assert.equal(calls, 2)
  }
})
test('late mount after identity readiness loads; room changes and background return still refresh', () => {
  const calls: string[] = []
  let releases = 0
  const page = createRoomReadLifecycle(
    (id) => calls.push(id),
    () => {
      releases++
    },
  )
  page.mount('A') // The first onShow was missed while ProfileGate awaited identity.
  page.mount('B')
  page.show('B')
  assert.deepEqual(calls, ['A', 'B'])
  page.hide()
  page.mount('C')
  assert.deepEqual(calls, ['A', 'B'])
  page.show('C')
  page.show('C')
  assert.deepEqual(calls, ['A', 'B', 'C'])
  page.hide()
  page.show('C')
  assert.deepEqual(calls, ['A', 'B', 'C', 'C'])
  page.leave()
  page.leave()
  page.show('C')
  assert.equal(releases, 1)
  assert.equal(calls.length, 4)
})
test('leaving invalidates the real store so a delayed room response cannot reopen the page', async () => {
  let resolve!: (value: RoomSnapshot) => void
  let data: unknown
  const api = createMockRoomApi({
    delayMs: 0,
    storage: {
      read: () => data,
      write(value) {
        data = value
      },
    },
  })
  const roomId = (await api.createRoom('point_ball', 'leaving-create-room')).roomId
  const snapshot = await api.getRoomSnapshot(roomId)
  const delayed = new Promise<RoomSnapshot>((yes) => {
    resolve = yes
  })
  const stores = createAppStores({ ...api, getRoomSnapshot: () => delayed }, () => 'unused')
  let pending: Promise<void> = Promise.resolve()
  const page = createRoomReadLifecycle(
    (id) => {
      pending = stores.openRoom(id)
    },
    () => stores.leaveView(),
  )
  await stores.ensureIdentity()
  page.mount(roomId)
  await Promise.resolve()
  page.leave()
  resolve(snapshot)
  await pending
  assert.equal(stores.room.getState().roomId, null)
  assert.equal(stores.room.getState().snapshot, null)
})
test('hidden point network events preserve connectivity but refresh only when alive and visible', () => {
  let alive = true,
    visible = true,
    online = true,
    reads = 0,
    updates = 0
  const network = createPointNetworkHandler({
    isAlive: () => alive,
    isVisible: () => visible,
    setOnline(value) {
      online = value
      updates++
    },
    async refresh() {
      reads++
    },
  })
  network({ isConnected: true })
  assert.equal(reads, 1)
  visible = false
  network({ isConnected: false })
  assert.equal(online, false)
  network({ isConnected: true })
  assert.equal(online, true)
  assert.equal(reads, 1)
  visible = true
  network({ isConnected: true })
  assert.equal(reads, 2)
  alive = false
  network({ isConnected: false })
  assert.equal(updates, 4)
  assert.equal(reads, 2)
})
