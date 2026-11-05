// Mount and the first onShow can arrive in either order, including after ProfileGate.
// A visibility cycle reads once; returning from the background starts a fresh cycle.
export function createRoomReadLifecycle(read: (roomId: string) => void, release: () => void) {
  let active = true
  let hidden = false
  let loadedRoomId = ''
  function readOnce(roomId: string) {
    if (!active || hidden || !roomId || loadedRoomId === roomId) return
    loadedRoomId = roomId
    read(roomId)
  }
  return {
    mount(roomId: string) {
      if (!active) {
        active = true
        hidden = false
      }
      readOnce(roomId)
    },
    show(roomId: string) {
      if (!active) return
      if (hidden) loadedRoomId = ''
      hidden = false
      readOnce(roomId)
    },
    hide() {
      hidden = true
    },
    leave() {
      if (!active) return
      active = false
      loadedRoomId = ''
      release()
    },
  }
}
