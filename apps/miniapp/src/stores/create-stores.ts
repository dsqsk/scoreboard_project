import { createRecentStore } from '../features/recent/store'
import type { RecentJournal } from '../features/recent/store'
import { createStore } from 'zustand/vanilla'
import { isPoker, isPresetBase } from '../features/poker/model'
import type { GameMode } from '@scoreboard/shared'
import type { Me, RoomApi, RoomSnapshot } from '../modules/room-api/types'
import { RoomApiError, errorMessage } from '../modules/room-api/errors'

type Phase = 'idle' | 'pending' | 'success' | 'failed' | 'unknown'
export interface PendingCommand {
  requestId: string
  signature: string
}
export interface PendingStorage {
  read(userId: string): PendingCommand | null
  write(value: PendingCommand | null, userId: string): void
}
export interface MutationState {
  phase: Phase
  command: PendingCommand | null
  roomId: string | null
  error: string | null
}
export function createAppStores(
  api: RoomApi,
  makeId: () => string,
  pendingStorage?: PendingStorage,
  recentJournal?: RecentJournal,
) {
  const identity = createStore<{
    me: Me | null
    status: 'idle' | 'loading' | 'ready' | 'error'
    error: string | null
  }>(() => ({ me: null, status: 'idle', error: null }))
  const room = createStore<{
    roomId: string | null
    snapshot: RoomSnapshot | null
    status: 'idle' | 'loading' | 'ready' | 'error'
    error: string | null
  }>(() => ({ roomId: null, snapshot: null, status: 'idle', error: null }))
  const mutation = createStore<MutationState>(() => ({
    phase: 'idle',
    command: null,
    roomId: null,
    error: null,
  }))
  const recentSession = createRecentStore({
    owner: async () => {
      await ensureIdentity()
      return identity.getState().me!.userId
    },
    list: (cursor) => api.listRecentPage(cursor, 20),
    enter: (roomId, requestId) => api.enterRoom(roomId, requestId),
    dismiss: (roomId, requestId) => api.dismissRecentRoom(roomId, requestId),
    makeId,
    journal: recentJournal,
  })
  const recent = recentSession.store
  let identityFlight: Promise<void> | undefined
  let generation = 0
  async function ensureIdentity() {
    if (identity.getState().me) return
    if (identityFlight) return identityFlight
    identity.setState({ status: 'loading', error: null })
    identityFlight = (async () => {
      try {
        identity.setState({ me: await api.getMe(), status: 'ready', error: null })
      } catch (error) {
        identity.setState({ status: 'error', error: errorMessage(error) })
        throw error
      } finally {
        identityFlight = undefined
      }
    })()
    return identityFlight
  }
  async function refreshIdentity() {
    const me = await api.getMe()
    identity.setState({ me, status: 'ready', error: null })
    return me
  }
  const loadRecent = () => recentSession.load()
  async function openRoom(roomId: string) {
    const current = ++generation
    room.setState({ roomId, snapshot: null, status: 'loading', error: null })
    try {
      await ensureIdentity()
      const snapshot = await api.getRoomSnapshot(roomId)
      if (current === generation) room.setState({ snapshot, status: 'ready' })
    } catch (error) {
      if (current === generation) room.setState({ status: 'error', error: errorMessage(error) })
    }
  }
  function leaveView() {
    generation++
    room.setState({ roomId: null, snapshot: null, status: 'idle', error: null })
  }
  function resetMutation() {
    if (mutation.getState().phase === 'pending' || mutation.getState().phase === 'unknown')
      return false
    mutation.setState({ phase: 'idle', command: null, error: null, roomId: null })
    return true
  }
  async function restorePending() {
    if (mutation.getState().phase !== 'idle' || !pendingStorage) return
    try {
      await ensureIdentity()
      if (mutation.getState().phase !== 'idle') return
      const command = pendingStorage.read(identity.getState().me!.userId)
      if (command)
        mutation.setState({ phase: 'unknown', command, error: '上次请求结果待确认，请重试查询' })
    } catch {
      /* Local recovery is best effort; no fictional success. */
    }
  }
  async function submit(kind: 'create' | 'join', value: GameMode | string): Promise<string | null> {
    const state = mutation.getState()
    if (state.phase === 'pending') return null
    const signature = `${kind}:${value}`
    if (state.phase === 'unknown' && state.command?.signature !== signature) return null
    const command =
      state.command?.signature === signature ? state.command : { signature, requestId: makeId() }
    mutation.setState({ phase: 'pending', command, error: null, roomId: null })
    let sent = false
    try {
      await ensureIdentity()
      pendingStorage?.write(command, identity.getState().me!.userId) // Store request identity BEFORE sending a write.
      sent = true
      let receipt
      if (kind === 'create' && value.includes('@')) {
        const [mode, rawBase] = value.split('@')
        const base = Number(rawBase)
        if (!mode || !isPoker(mode) || !isPresetBase(base) || value !== `${mode}@${base}`)
          throw new RoomApiError('INVALID_ARGUMENT', '请选择有效的扑克底分')
        if (!api.createPokerRoom)
          throw new RoomApiError(
            'RULE_NOT_CONFIGURED',
            '云端扑克创建接口尚未接入，暂时无法创建带底分的房间',
          )
        receipt = await api.createPokerRoom(mode, base, command.requestId)
      } else {
        receipt =
          kind === 'create'
            ? await api.createRoom(value as GameMode, command.requestId)
            : await api.joinRoom(value, command.requestId)
      }
      try {
        pendingStorage?.write(null, identity.getState().me!.userId)
      } catch {
        /* Replay remains idempotent. */
      }
      mutation.setState({ phase: 'success', roomId: receipt.roomId, error: null })
      return receipt.roomId
    } catch (error) {
      const unknown =
        sent &&
        (!(error instanceof RoomApiError) ||
          error.code === 'TRANSPORT_UNKNOWN' ||
          error.code === 'INVALID_RESPONSE' ||
          error.code === 'MAINTENANCE')
      if (!unknown) {
        try {
          pendingStorage?.write(null, identity.getState().me!.userId)
        } catch {
          /* Keep original receipt identity if storage is unavailable. */
        }
      }
      mutation.setState({ phase: unknown ? 'unknown' : 'failed', error: errorMessage(error) })
      return null
    }
  }
  return {
    identity,
    room,
    mutation,
    recent,
    recentSession,
    ensureIdentity,
    refreshIdentity,
    loadRecent,
    openRoom,
    leaveView,
    resetMutation,
    restorePending,
    submit,
  }
}
