import { createStore } from 'zustand/vanilla'
import type { RoomPreview } from '../../modules/room-api/types'
import { RoomApiError, errorMessage } from '../../modules/room-api/errors'
export interface RecentOperation {
  kind: 'dismiss' | 'enter'
  roomId: string
  requestId: string
  userId: string
  preview?: RoomPreview
}
export interface RecentJournal {
  read(userId: string): RecentOperation | null
  write(userId: string, value: RecentOperation | null): void
}
export interface RecentPorts {
  owner(): Promise<string>
  list(cursor?: string): Promise<{ rooms: RoomPreview[]; nextCursor: string | null }>
  dismiss(roomId: string, requestId: string): Promise<unknown>
  enter(roomId: string, requestId: string): Promise<unknown>
  makeId(): string
  journal?: RecentJournal
}
export function createRecentStore(ports: RecentPorts) {
  const store = createStore<{
    rooms: RoomPreview[]
    nextCursor: string | null
    status: 'idle' | 'loading' | 'ready' | 'error'
    error: string | null
    loadingMore: boolean
    phase: 'idle' | 'pending' | 'unknown' | 'failed'
    operation: RecentOperation | null
    message: string | null
  }>(() => ({
    rooms: [],
    nextCursor: null,
    status: 'idle',
    error: null,
    loadingMore: false,
    phase: 'idle',
    operation: null,
    message: null,
  }))
  let owner = ''
  let generation = 0
  let busy = false
  async function initialize() {
    const userId = await ports.owner()
    if (owner !== userId) {
      generation++
      owner = ''
      store.setState({
        rooms: [],
        nextCursor: null,
        status: 'idle',
        error: null,
        operation: null,
        phase: 'idle',
        message: null,
        loadingMore: false,
      })
      const operation = ports.journal?.read(userId)
      if (operation) {
        if (
          operation.userId !== userId ||
          !operation.roomId ||
          !operation.requestId ||
          !['enter', 'dismiss'].includes(operation.kind)
        )
          throw new Error('最近房间待确认操作无法读取，请保留数据并检查')
        store.setState({
          operation,
          ...(operation.preview ? { rooms: [operation.preview], status: 'ready' as const } : {}),
          phase: 'unknown',
          message: '上次操作结果待确认，请确认原请求',
        })
      }
      owner = userId
    }
    return userId
  }
  async function load(more = false) {
    let current: number | undefined
    try {
      await initialize()
      const state = store.getState()
      if (state.phase === 'pending' || state.phase === 'unknown') return
      if (more && (!state.nextCursor || state.loadingMore)) return
      current = ++generation
      if (more) store.setState({ loadingMore: true, error: null })
      else store.setState({ status: 'loading', error: null })
      const rooms = more ? [...state.rooms] : []
      let cursor = more ? state.nextCursor! : undefined
      const seen = new Set<string>()
      const target = more ? rooms.length + 20 : 3
      let nextCursor: string | null = null
      do {
        if (cursor) {
          if (seen.has(cursor)) throw new Error('最近房间分页异常，请刷新')
          seen.add(cursor)
        }
        const page = await ports.list(cursor)
        if (current !== generation) return
        for (const room of page.rooms)
          if (!rooms.some((item) => item.roomId === room.roomId)) rooms.push(room)
        nextCursor = page.nextCursor
        cursor = nextCursor ?? undefined
      } while (cursor && rooms.length < target)
      store.setState({ rooms, nextCursor, status: 'ready', loadingMore: false })
    } catch (error) {
      if (current !== undefined && current !== generation) return
      store.setState({
        status: store.getState().rooms.length ? 'ready' : 'error',
        error: errorMessage(error),
        loadingMore: false,
      })
    }
  }
  async function run(kind: RecentOperation['kind'], roomId: string): Promise<boolean> {
    if (busy) return false
    busy = true
    let sent = false
    let operation: RecentOperation | null = null
    let operationGeneration: number | undefined
    try {
      const userId = await initialize()
      const state = store.getState()
      if (
        state.phase === 'unknown' &&
        (state.operation?.kind !== kind || state.operation.roomId !== roomId)
      )
        return false
      operation =
        state.operation?.kind === kind && state.operation.roomId === roomId
          ? state.operation
          : {
              kind,
              roomId,
              userId,
              requestId: ports.makeId(),
              ...(kind === 'dismiss'
                ? { preview: state.rooms.find((room) => room.roomId === roomId) }
                : {}),
            }
      operationGeneration = ++generation
      store.setState({
        phase: 'pending',
        operation,
        error: null,
        message: null,
        loadingMore: false,
      })
      ports.journal?.write(userId, operation)
      sent = true
      await (kind === 'dismiss'
        ? ports.dismiss(roomId, operation.requestId)
        : ports.enter(roomId, operation.requestId))
      if (owner !== userId || generation !== operationGeneration) return false
      // Clear the journal before permitting another operation. A failed clear is recoverable.
      ports.journal?.write(userId, null)
      store.setState({
        phase: 'idle',
        operation: null,
        message: kind === 'dismiss' ? '已从最近房间移除' : null,
        ...(kind === 'dismiss'
          ? { rooms: store.getState().rooms.filter((room) => room.roomId !== roomId) }
          : {}),
      })
      await load()
      return true
    } catch (error) {
      if (operation && (owner !== operation.userId || generation !== operationGeneration))
        return false
      const unknown =
        sent &&
        (!(error instanceof RoomApiError) ||
          ['TRANSPORT_UNKNOWN', 'INVALID_RESPONSE', 'MAINTENANCE'].includes(error.code))
      if (!unknown && operation) {
        try {
          ports.journal?.write(operation.userId, null)
        } catch {}
      }
      store.setState({
        phase: unknown ? 'unknown' : 'failed',
        operation,
        message: unknown
          ? '操作结果待确认，请确认原请求'
          : kind === 'dismiss'
            ? '移除失败，请重试'
            : '进入房间失败，请重试',
        error: errorMessage(error),
        status: store.getState().rooms.length ? 'ready' : store.getState().status,
      })
      return false
    } finally {
      busy = false
    }
  }
  async function recover() {
    const op = store.getState().operation
    return op ? run(op.kind, op.roomId) : false
  }
  return { store, load: () => load(), loadMore: () => load(true), run, recover, initialize }
}
