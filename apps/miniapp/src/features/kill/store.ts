import { createStore } from 'zustand/vanilla'
import { RoomApiError, errorMessage } from '../../modules/room-api/errors'
import type { KillApi, KillCommand, KillSnapshot } from './api'
export interface PendingKill {
  roomId: string
  requestId: string
  command: KillCommand
}
interface PendingStorage {
  read(): PendingKill | null
  write(command: PendingKill | null): void
}
interface State {
  roomId: string
  snapshot: KillSnapshot | null
  loading: boolean
  busy: boolean
  error: string | null
  pending: PendingKill | null
}
export function createKillStore(api: KillApi, makeId: () => string, storage: PendingStorage) {
  const store = createStore<State>(() => ({
    roomId: '',
    snapshot: null,
    loading: false,
    busy: false,
    error: null,
    pending: null,
  }))
  let generation = 0
  let inFlight = false
  async function open(roomId: string) {
    const token = ++generation
    store.setState({ roomId, snapshot: null, loading: true, error: null })
    try {
      const snapshot = await api.get(roomId)
      const pending = storage.read()
      if (token === generation)
        store.setState({
          snapshot,
          loading: false,
          pending,
          error: pending ? '有一条操作结果待确认，请先重试原操作。' : null,
        })
    } catch (error) {
      if (token === generation) store.setState({ loading: false, error: errorMessage(error) })
    }
  }
  async function submit(roomId: string, command?: KillCommand) {
    if (inFlight) return false
    const current = store.getState()
    if (current.pending && command) return false
    const pending = current.pending ?? (command ? { roomId, command, requestId: makeId() } : null)
    if (!pending) return false
    inFlight = true
    const token = generation
    store.setState({ busy: true, error: null })
    let committed = false
    try {
      storage.write(pending)
      store.setState({ pending })
      await api.execute(pending.roomId, pending.command, pending.requestId)
      committed = true
      storage.write(null)
      store.setState({ pending: null })
      if (token === generation && store.getState().roomId === pending.roomId) {
        const snapshot = await api.get(pending.roomId)
        if (token === generation && store.getState().roomId === pending.roomId)
          store.setState({ snapshot })
      }
      return true
    } catch (error) {
      // Unknown outcomes retain the exact request, including across page reloads.
      const definitive = error instanceof RoomApiError && error.code !== 'TRANSPORT_UNKNOWN'
      if (definitive && !committed) {
        try {
          storage.write(null)
          store.setState({ pending: null })
        } catch {
          /* Keep retry metadata if its removal failed. */
        }
        if (token === generation && store.getState().roomId === pending.roomId) {
          try {
            const snapshot = await api.get(pending.roomId)
            if (token === generation && store.getState().roomId === pending.roomId)
              store.setState({ snapshot })
          } catch {
            /* Preserve last confirmed snapshot. */
          }
        }
      }
      store.setState({
        error: committed ? '操作已保存，但刷新失败，请刷新房间查看。' : errorMessage(error),
      })
      return false
    } finally {
      inFlight = false
      store.setState({ busy: false })
    }
  }
  return {
    store,
    open,
    submit,
    leave() {
      generation++
      store.setState({ roomId: '', snapshot: null })
    },
  }
}
