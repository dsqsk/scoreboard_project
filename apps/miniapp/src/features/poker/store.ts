import { createStore } from 'zustand/vanilla'
import { RoomApiError, errorMessage } from '../../modules/room-api/errors'
import type { PokerApi, PokerCommand, PokerEntry, PokerSnapshot } from './api'
export interface PendingPoker {
  roomId: string
  requestId: string
  command: PokerCommand
}
interface Journal {
  read(userId: string): PendingPoker | null
  write(userId: string, pending: PendingPoker | null): void
}
interface Draft {
  direction: 1 | -1
  value: number | null
  mingA: boolean
}
interface State {
  roomId: string
  userId: string
  snapshot: PokerSnapshot | null
  loading: boolean
  busy: boolean
  pending: PendingPoker | null
  error: string | null
  feedback: string | null
  draft: Draft
}
const emptyDraft = (): Draft => ({ direction: 1, value: null, mingA: false })
export function createPokerStore(api: PokerApi, makeId: () => string, journal: Journal) {
  const store = createStore<State>(() => ({
    roomId: '',
    userId: '',
    snapshot: null,
    loading: false,
    busy: false,
    pending: null,
    error: null,
    feedback: null,
    draft: emptyDraft(),
  }))
  let generation = 0
  let flight: Promise<boolean> | null = null
  async function open(roomId: string, userId: string) {
    const token = ++generation
    const previous = store.getState()
    store.setState({
      roomId,
      userId,
      loading: true,
      error: null,
      feedback: null,
      snapshot: previous.roomId === roomId && previous.userId === userId ? previous.snapshot : null,
      draft:
        previous.roomId === roomId && previous.userId === userId ? previous.draft : emptyDraft(),
    })
    try {
      // Finish any in-flight write before refreshing; no stale read can replace its result.
      if (flight) await flight
      const pending = journal.read(userId)
      const snapshot = await api.get(roomId)
      if (token !== generation) return
      const changed =
        previous.snapshot &&
        previous.roomId === roomId &&
        (previous.snapshot.configRevision !== snapshot.configRevision ||
          previous.snapshot.base !== snapshot.base ||
          previous.snapshot.mode !== snapshot.mode ||
          previous.snapshot.participants.map((p) => p.userId).join('|') !==
            snapshot.participants.map((p) => p.userId).join('|'))
      const draft =
        pending?.roomId === roomId
          ? {
              direction: pending.command.direction,
              value: pending.command.value,
              mingA: pending.command.mingA,
            }
          : changed
            ? emptyDraft()
            : store.getState().draft
      store.setState({
        snapshot,
        pending,
        loading: false,
        draft,
        error: pending
          ? '上次记分结果待确认，请先重试原记分。'
          : changed
            ? '底分或名单已变化，请重新选择记分值。'
            : null,
      })
    } catch (error) {
      if (token === generation) store.setState({ loading: false, error: errorMessage(error) })
    }
  }
  function select(patch: Partial<Draft>) {
    const state = store.getState()
    if (state.busy || state.loading || state.pending || !state.snapshot?.canRecord) return
    store.setState({ draft: { ...state.draft, ...patch }, feedback: null })
  }
  async function perform(): Promise<boolean> {
    const state = store.getState()
    if (!state.userId || state.loading) return false
    let pending = state.pending
    if (!pending) {
      if (!state.snapshot?.canRecord || state.draft.value === null) return false
      pending = {
        roomId: state.roomId,
        requestId: makeId(),
        command: {
          ...state.draft,
          value: state.draft.value,
          mode: state.snapshot.mode,
          base: state.snapshot.base,
          configRevision: state.snapshot.configRevision,
        },
      }
    }
    const token = generation
    const userId = state.userId
    const operation = pending
    store.setState({ busy: true, error: null, feedback: null })
    let receipt: PokerEntry | null = null
    try {
      journal.write(userId, operation)
      store.setState({ pending: operation })
      receipt = await api.save(operation.roomId, operation.command, operation.requestId)
      journal.write(userId, null)
      store.setState({ pending: null })
      if (token === generation)
        store.setState({
          draft: { direction: operation.command.direction, value: null, mingA: false },
          feedback: `${operation.roomId === state.roomId ? '已记' : '上次房间已记'} ${receipt.delta > 0 ? '+' : ''}${receipt.delta}分`,
        })
      const snapshot = await api.get(state.roomId)
      if (token === generation) store.setState({ snapshot })
      return true
    } catch (error) {
      const definite =
        error instanceof RoomApiError &&
        !['TRANSPORT_UNKNOWN', 'INVALID_RESPONSE'].includes(error.code)
      if (!receipt && definite) {
        try {
          journal.write(userId, null)
          store.setState({ pending: null })
        } catch {
          /* Keep original operation until recovery succeeds. */
        }
        if (
          error.code === 'STALE_CONTEXT' ||
          error.code === 'CONFLICT' ||
          error.code === 'FORBIDDEN'
        ) {
          try {
            const snapshot = await api.get(state.roomId)
            if (token === generation) store.setState({ snapshot, draft: emptyDraft() })
          } catch {
            /* Preserve confirmed data. */
          }
        }
      }
      if (token === generation)
        store.setState({
          error: receipt ? '记分已保存，但刷新失败，请刷新查看。' : errorMessage(error),
        })
      return false
    } finally {
      store.setState({ busy: false })
    }
  }
  function submit() {
    if (flight) return flight
    const current = perform()
    flight = current
    void current.finally(() => {
      if (flight === current) flight = null
    })
    return current
  }
  return {
    store,
    open,
    select,
    submit,
    leave() {
      generation++
      store.setState({ roomId: '', snapshot: null, loading: false, feedback: null })
    },
  }
}
