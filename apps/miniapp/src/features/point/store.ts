import { isPointReceipt } from './receipt'
import type { CommandReceipt } from '@scoreboard/shared'
import { createClickGuard } from '../../utils/click-guard'
import { createStore } from 'zustand/vanilla'
import { RoomApiError, errorMessage } from '../../modules/room-api/errors'
import type { PointApi, PointCommand, PointSnapshot } from './api'
export interface PointOperation {
  roomId: string
  requestId: string
  command: PointCommand
}
interface Request extends PointOperation {
  phase: 'pending' | 'unknown'
}
interface Journal {
  read(userId: string): PointOperation[]
  write(userId: string, requests: PointOperation[]): void
}
interface State {
  roomId: string
  userId: string
  snapshot: PointSnapshot | null
  loading: boolean
  online: boolean
  requests: Request[]
  error: string | null
  loadingMore: boolean
}
export function createPointStore(
  api: PointApi,
  makeId: () => string,
  journal: Journal,
  now: () => number = Date.now,
) {
  const store = createStore<State>(() => ({
    roomId: '',
    userId: '',
    snapshot: null,
    loading: false,
    online: true,
    requests: [],
    error: null,
    loadingMore: false,
  }))
  const flights = new Map<string, Promise<boolean>>()
  const cardFlights = new Set<string>()
  const cardKey = (userId: string, roomId: string, activityId: string, number: number) =>
    JSON.stringify([userId, roomId, activityId, number])
  const acceptSubmit = createClickGuard(now)
  const acceptInteraction = createClickGuard(now)
  const acceptRecovery = createClickGuard(now)
  let generation = 0
  let reading = false
  function write(requests: Request[], userId: string) {
    journal.write(
      userId,
      requests.map(({ phase: _phase, ...request }) => request),
    )
    store.setState({ requests })
  }
  function apply(snapshot: PointSnapshot, token: number) {
    const state = store.getState()
    if (token !== generation || snapshot.roomId !== state.roomId) return
    const previous = state.snapshot
    if (
      previous &&
      (snapshot.roomRevision < previous.roomRevision ||
        (snapshot.activity?.activityId === previous.activity?.activityId &&
          (snapshot.activity?.revision ?? 0) < (previous.activity?.revision ?? 0)))
    )
      return
    store.setState({ snapshot })
  }
  async function open(roomId: string, userId: string) {
    const token = ++generation
    store.setState({
      roomId,
      userId,
      snapshot: null,
      loading: true,
      loadingMore: false,
      error: null,
    })
    try {
      await Promise.allSettled([...flights.values()])
      const requests: Request[] = journal
        .read(userId)
        .map((request) => ({ ...request, phase: 'unknown' }))
      if (token !== generation) return
      store.setState({ requests })
      const snapshot = await api.get(roomId)
      if (token !== generation) return
      apply(snapshot, token)
      store.setState({
        loading: false,
        error: requests.length ? '有操作结果待确认，请先确认原操作。' : null,
      })
    } catch (error) {
      if (token === generation) store.setState({ loading: false, error: errorMessage(error) })
    }
  }
  async function refresh() {
    const state = store.getState()
    if (!state.roomId || !state.online || state.loading || flights.size || reading) return
    const token = generation
    reading = true
    try {
      apply(await api.get(state.roomId), token)
      if (token === generation && store.getState().error?.startsWith('刷新失败：'))
        store.setState({ error: null })
    } catch (error) {
      if (token === generation) store.setState({ error: `刷新失败：${errorMessage(error)}` })
    } finally {
      reading = false
    }
  }
  async function loadMore(kind: 'results' | 'changes') {
    const state = store.getState()
    const cursor =
      kind === 'results' ? state.snapshot?.nextResultCursor : state.snapshot?.nextChangeCursor
    if (!cursor || !state.snapshot || state.loadingMore || !state.online) return
    const token = generation
    const activityId = state.snapshot.activity?.activityId
    store.setState({ loadingMore: true })
    try {
      const page = await api.get(
        state.roomId,
        kind === 'results' ? { resultCursor: cursor } : { changeCursor: cursor },
      )
      const current = store.getState().snapshot
      if (token !== generation || !current) return
      if ((kind === 'results' ? page.nextResultCursor : page.nextChangeCursor) === cursor)
        throw new RoomApiError('INVALID_RESPONSE', '分页游标未前进，请刷新后重试')
      if (kind === 'results') {
        const ids = new Set(current.results.map((r) => r.activityId))
        store.setState({
          snapshot: {
            ...current,
            results: [...current.results, ...page.results.filter((r) => !ids.has(r.activityId))],
            nextResultCursor: page.nextResultCursor,
          },
        })
      } else {
        if (
          !current.activity ||
          !page.activity ||
          page.activity.activityId !== activityId ||
          current.activity.activityId !== activityId
        )
          throw new RoomApiError('STALE_CONTEXT', '本场已变化，请刷新修改记录')
        const ids = new Set(current.activity.changes.map((c) => c.requestId))
        store.setState({
          snapshot: {
            ...current,
            activity: {
              ...current.activity,
              changes: [
                ...current.activity.changes,
                ...page.activity.changes.filter((c) => !ids.has(c.requestId)),
              ],
            },
            nextChangeCursor: page.nextChangeCursor,
          },
        })
      }
    } catch (error) {
      if (token === generation) store.setState({ error: errorMessage(error) })
    } finally {
      if (token === generation) store.setState({ loadingMore: false })
    }
  }
  function applyCommit(receipt: CommandReceipt, token: number, userId: string) {
    const state = store.getState(),
      current = state.snapshot,
      point = receipt.pointState
    if (
      !point ||
      token !== generation ||
      state.userId !== userId ||
      state.roomId !== receipt.roomId ||
      !current?.activity ||
      current.activity.activityId !== point.activityId ||
      current.activity.status !== 'open'
    )
      return
    const changes = current.activity.changes.some((c) => c.requestId === point.change.requestId)
      ? current.activity.changes
      : [point.change, ...current.activity.changes].sort((a, b) => b.createdAt - a.createdAt)
    const newer =
      receipt.roomRevision! >= current.roomRevision && point.revision >= current.activity.revision
    store.setState({
      snapshot: {
        ...current,
        ...(newer ? { roomRevision: receipt.roomRevision! } : {}),
        activity: {
          ...current.activity,
          changes,
          ...(newer
            ? { cards: point.cards, earnedPoints: point.earnedPoints, revision: point.revision }
            : {}),
        },
      },
    })
  }
  function removeOperation(operation: PointOperation, userId: string, token: number) {
    // Read the owning user's durable journal, never another session's visible requests.
    journal.write(
      userId,
      journal.read(userId).filter((r) => r.requestId !== operation.requestId),
    )
    if (token === generation && store.getState().userId === userId)
      store.setState({
        requests: store.getState().requests.filter((r) => r.requestId !== operation.requestId),
      })
  }
  async function perform(operation: PointOperation, retry: boolean) {
    const token = generation
    const userId = store.getState().userId
    let confirmed = false
    try {
      const requests = store.getState().requests.filter((r) => r.requestId !== operation.requestId)
      write([...requests, { ...operation, phase: 'pending' }], userId)
      store.setState({ error: null })
      const receipt = await api.execute(operation.roomId, operation.command, operation.requestId)
      if (receipt !== undefined) {
        if (
          !isPointReceipt(receipt, operation.roomId, operation.command, operation.requestId) ||
          (receipt.pointState && receipt.pointState.change.actorUserId !== userId)
        )
          throw new RoomApiError('INVALID_RESPONSE', '写入回执异常，请确认原操作')
        const activity = store.getState().snapshot?.activity
        if (
          receipt.pointState &&
          token === generation &&
          activity &&
          activity.activityId === receipt.activityId &&
          (Object.keys(receipt.pointState.earnedPoints).length !== activity.participants.length ||
            activity.participants.some((p) => !(p.userId in receipt.pointState!.earnedPoints)))
        )
          throw new RoomApiError('INVALID_RESPONSE', '回执名单异常，请确认原操作')
      }
      confirmed = true
      if (receipt?.pointState) applyCommit(receipt, token, userId)
      removeOperation(operation, userId, token)
      if (token === generation && !receipt?.pointState) {
        try {
          apply(await api.get(store.getState().roomId), token)
        } catch (error) {
          if (token === generation)
            store.setState({ error: `操作已保存，但刷新失败：${errorMessage(error)}` })
        }
      }
      return true
    } catch (error) {
      const definite =
        !confirmed &&
        error instanceof RoomApiError &&
        !['TRANSPORT_UNKNOWN', 'INVALID_RESPONSE', 'MAINTENANCE'].includes(error.code)
      if (token !== generation || store.getState().userId !== userId) {
        if (definite) {
          try {
            removeOperation(operation, userId, token)
          } catch {
            /* Keep the owning journal recoverable. */
          }
        }
        return false
      }
      const exists = store.getState().requests.some((r) => r.requestId === operation.requestId)
      if (exists) {
        if (definite) {
          try {
            removeOperation(operation, userId, token)
          } catch {
            store.setState({
              requests: store
                .getState()
                .requests.map((r) =>
                  r.requestId === operation.requestId ? { ...r, phase: 'unknown' } : r,
                ),
            })
          }
        } else
          store.setState({
            requests: store
              .getState()
              .requests.map((r) =>
                r.requestId === operation.requestId ? { ...r, phase: 'unknown' } : r,
              ),
          })
      }
      if (token === generation) {
        store.setState({
          error: confirmed ? '操作已保存，但本地确认失败，请确认原操作。' : errorMessage(error),
        })
        if (
          definite &&
          error instanceof RoomApiError &&
          ['CONFLICT', 'STALE_CONTEXT', 'ALREADY_POSTED', 'FORBIDDEN'].includes(error.code)
        ) {
          try {
            apply(await api.get(store.getState().roomId), token)
          } catch {
            /* Keep last confirmed state and original failure. */
          }
        }
      }
      // A failure before the first journal write sent nothing; a retry keeps its existing journal.
      if (!exists && retry && token === generation)
        store.setState({ error: '无法确认原操作，请保留本地数据并重试。' })
      return false
    }
  }
  function launch(operation: PointOperation, retry = false) {
    const existing = flights.get(operation.requestId)
    if (existing) return existing
    const promise = perform(operation, retry)
    flights.set(operation.requestId, promise)
    void promise.finally(() => {
      if (flights.get(operation.requestId) === promise) flights.delete(operation.requestId)
    })
    return promise
  }
  function submit(command: PointCommand) {
    const state = store.getState()
    if (
      !state.userId ||
      !state.snapshot ||
      state.loading ||
      !state.online ||
      state.requests.some((r) => r.phase === 'unknown')
    )
      return Promise.resolve(false)
    const exclusive = command.kind === 'prepare' || command.kind === 'post'
    if (
      state.requests.some((r) => r.command.kind === 'prepare' || r.command.kind === 'post') ||
      (exclusive && state.requests.length)
    )
      return Promise.resolve(false)
    if (
      'number' in command &&
      state.requests.some((r) => 'number' in r.command && r.command.number === command.number)
    )
      return Promise.resolve(false)
    const key =
      'number' in command
        ? cardKey(state.userId, state.roomId, command.activityId, command.number)
        : null
    if (key && (cardFlights.has(key) || !acceptSubmit(key))) return Promise.resolve(false)
    if (key) cardFlights.add(key)
    const result = launch({ roomId: state.roomId, command, requestId: makeId() })
    if (key) void result.finally(() => cardFlights.delete(key))
    return result
  }
  async function recover() {
    if (!store.getState().online) return
    const requests = store.getState().requests.filter((r) => r.phase === 'unknown')
    for (const request of requests) {
      if (acceptRecovery(request.requestId)) await launch(request, true)
    }
  }
  return {
    store,
    beginCardInteraction(activityId: string, number: number) {
      const state = store.getState()
      if (
        !state.roomId ||
        state.loading ||
        !state.online ||
        state.snapshot?.activity?.activityId !== activityId ||
        state.snapshot.activity.status !== 'open' ||
        state.requests.some(
          (r) =>
            r.phase === 'unknown' ||
            r.command.kind === 'prepare' ||
            r.command.kind === 'post' ||
            ('number' in r.command && r.command.number === number),
        )
      )
        return false
      const key = cardKey(state.userId, state.roomId, activityId, number)
      return !cardFlights.has(key) && acceptInteraction(key)
    },
    open,
    refresh,
    submit,
    recover,
    loadMore,
    setOnline(online: boolean) {
      store.setState({ online })
    },
    leave() {
      generation++
      store.setState({ roomId: '', snapshot: null, loading: false })
    },
  }
}
