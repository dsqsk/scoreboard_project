import { createClickGuard } from '../../utils/click-guard'
import { createStore } from 'zustand/vanilla'
import { RoomApiError, errorMessage } from '../../modules/room-api/errors'
import { requestFor } from './api'
import type { DaAApi, DaACommand, DaASnapshot } from './api'
import type { DaAValue } from '@scoreboard/shared'
export interface DaAPending {
  roomId: string
  userId: string
  requestId: string
  command: DaACommand
}
export interface DaAJournal {
  read(userId: string): DaAPending | null
  write(userId: string, value: DaAPending | null): void
}
const draft = () => ({ direction: 1 as 1 | -1, value: null as DaAValue | null, mingA: false })
export function createDaAStore(
  api: DaAApi,
  makeId: () => string,
  journal: DaAJournal,
  now: () => number = Date.now,
) {
  const store = createStore<{
    roomId: string
    userId: string
    snapshot: DaASnapshot | null
    draft: ReturnType<typeof draft>
    loading: boolean
    loadingMore: boolean
    busy: boolean
    online: boolean
    pending: DaAPending | null
    error: string | null
    feedback: string | null
    journalReady: boolean
  }>(() => ({
    roomId: '',
    userId: '',
    snapshot: null,
    draft: draft(),
    loading: false,
    loadingMore: false,
    busy: false,
    online: true,
    pending: null,
    error: null,
    feedback: null,
    journalReady: false,
  }))
  const acceptClick = createClickGuard(now)
  let generation = 0,
    readSerial = 0
  let flight: Promise<boolean> | null = null
  let reading = false
  const permissionError = (error: unknown) =>
    error instanceof RoomApiError &&
    ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'STALE_CONTEXT', 'RULE_NOT_CONFIGURED'].includes(
      error.code,
    )
  function active(token: number) {
    return token === generation
  }
  function apply(snapshot: DaASnapshot, token: number) {
    if (!active(token) || snapshot.roomId !== store.getState().roomId) return
    const previous = store.getState().snapshot
    if (
      previous &&
      (snapshot.roomRevision < previous.roomRevision ||
        (previous.activity?.activityId === snapshot.activity?.activityId &&
          (snapshot.activity?.revision ?? 0) < (previous.activity?.revision ?? 0)))
    )
      return
    const canMerge =
      previous &&
      previous.entries.length > 20 &&
      previous.activity?.activityId === snapshot.activity?.activityId &&
      snapshot.entries.some((e) => previous.entries.some((old) => old.entryId === e.entryId))
    if (canMerge) {
      const ids = new Set(snapshot.entries.map((e) => e.entryId))
      snapshot = {
        ...snapshot,
        entries: [...snapshot.entries, ...previous.entries.filter((e) => !ids.has(e.entryId))],
        nextCursor: previous.nextCursor,
      }
    }
    store.setState({ snapshot })
  }
  async function open(roomId: string, userId: string) {
    const token = ++generation
    readSerial++
    const same = store.getState().roomId === roomId && store.getState().userId === userId
    store.setState({
      roomId,
      userId,
      loading: true,
      loadingMore: false,
      busy: false,
      error: null,
      feedback: null,
      journalReady: false,
      pending: null,
      ...(same ? {} : { snapshot: null, draft: draft() }),
    })
    try {
      if (flight) await flight
      if (!active(token)) return
      const pending = journal.read(userId)
      if (pending) {
        if (pending.userId !== userId) throw new Error('待确认操作身份不符，请保留数据检查')
        requestFor(pending.roomId, pending.command, pending.requestId)
      }
      store.setState({
        pending,
        journalReady: true,
        ...(pending?.roomId === roomId && pending.command.kind === 'delta'
          ? {
              draft: {
                direction: pending.command.direction,
                value: pending.command.value,
                mingA: pending.command.mingA,
              },
            }
          : {}),
      })
      apply(await api.get(roomId), token)
      if (active(token))
        store.setState({
          loading: false,
          error: pending ? '有操作结果待确认，请先确认原操作。' : null,
        })
    } catch (error) {
      if (active(token))
        store.setState({
          loading: false,
          error: errorMessage(error),
          ...(permissionError(error) ? { snapshot: null } : {}),
        })
    }
  }
  async function refresh() {
    const state = store.getState()
    if (!state.roomId || !state.online || state.loading || state.loadingMore || flight || reading)
      return
    const token = generation,
      serial = ++readSerial
    reading = true
    try {
      const snapshot = await api.get(state.roomId)
      if (serial === readSerial) {
        apply(snapshot, token)
        if (
          active(token) &&
          !store.getState().pending &&
          store.getState().error?.startsWith('刷新失败：')
        )
          store.setState({ error: null })
      }
    } catch (error) {
      if (active(token) && serial === readSerial)
        store.setState({
          error: `刷新失败：${errorMessage(error)}`,
          ...(permissionError(error) ? { snapshot: null } : {}),
        })
    } finally {
      reading = false
    }
  }
  async function loadMore() {
    const state = store.getState(),
      cursor = state.snapshot?.nextCursor
    if (
      !cursor ||
      !state.snapshot ||
      !state.online ||
      state.loadingMore ||
      state.loading ||
      flight ||
      reading
    )
      return
    const token = generation,
      serial = ++readSerial
    store.setState({ loadingMore: true })
    try {
      const page = await api.get(state.roomId, cursor)
      if (!active(token) || serial !== readSerial) return
      if (page.nextCursor === cursor) throw new Error('分页未前进，请刷新记录')
      const current = store.getState().snapshot!
      if (
        current.activity?.activityId !== page.activity?.activityId ||
        current.activity?.configRevision !== page.activity?.configRevision
      ) {
        await refresh()
        return
      }
      const ids = new Set(current.entries.map((e) => e.entryId))
      const newer =
        page.roomRevision >= current.roomRevision &&
        (page.activity?.revision ?? 0) >= (current.activity?.revision ?? 0)
      store.setState({
        snapshot: {
          ...(newer ? { ...page } : current),
          entries: [...current.entries, ...page.entries.filter((e) => !ids.has(e.entryId))],
          nextCursor: page.nextCursor,
        },
      })
    } catch (error) {
      if (active(token) && serial === readSerial)
        store.setState({
          error: errorMessage(error),
          ...(permissionError(error) ? { snapshot: null } : {}),
        })
    } finally {
      if (active(token)) store.setState({ loadingMore: false })
    }
  }
  function select(patch: Partial<ReturnType<typeof draft>>) {
    const s = store.getState()
    if (
      s.busy ||
      s.loading ||
      s.pending ||
      !s.online ||
      !s.journalReady ||
      !s.snapshot?.canRecord ||
      !s.snapshot.activity?.participants.some((p) => p.userId === s.userId)
    )
      return
    store.setState({ draft: { ...s.draft, ...patch }, feedback: null })
  }
  async function perform(command?: DaACommand): Promise<boolean> {
    const state = store.getState(),
      token = generation
    if (!state.roomId || !state.userId || !state.online || state.loading || !state.journalReady)
      return false
    if (state.pending && command) return false
    let op = state.pending
    if (!op) {
      if (!command) {
        const a = state.snapshot?.activity
        if (
          !state.snapshot?.canRecord ||
          !a ||
          !a.participants.some((p) => p.userId === state.userId) ||
          state.draft.value === null
        )
          return false
        command = {
          kind: 'delta',
          activityId: a.activityId,
          expectedConfigRevision: a.configRevision,
          ...state.draft,
          value: state.draft.value,
        }
      } else if (command.kind === 'prepare' && state.snapshot?.activity) return false
      op = {
        roomId: state.roomId,
        userId: state.userId,
        requestId: makeId(),
        command: JSON.parse(JSON.stringify(command)) as DaACommand,
      }
    }
    const operation = op
    let sent = false,
      confirmed = false
    readSerial++
    store.setState({ busy: true, error: null, feedback: null, loadingMore: false })
    try {
      requestFor(operation.roomId, operation.command, operation.requestId)
      journal.write(operation.userId, operation)
      if (active(token)) store.setState({ pending: operation })
      sent = true
      await api.execute(operation.roomId, operation.command, operation.requestId)
      confirmed = true
      journal.write(operation.userId, null)
      if (!active(token)) return true
      const current = store.getState().snapshot?.activity
      const belongs =
        operation.roomId === state.roomId &&
        (operation.command.kind === 'prepare' ||
          operation.command.activityId === current?.activityId)
      store.setState({
        pending: null,
        ...(belongs ? { draft: { ...state.draft, value: null, mingA: false } } : {}),
        feedback: belongs
          ? operation.command.kind === 'prepare'
            ? '参与名单已确认'
            : '记分已保存'
          : '原房间操作已确认，本场未新增记分',
      })
      apply(await api.get(state.roomId), token)
      return true
    } catch (error) {
      if (!active(token)) return confirmed
      const known =
        !sent ||
        (!confirmed &&
          error instanceof RoomApiError &&
          !['TRANSPORT_UNKNOWN', 'INVALID_RESPONSE', 'MAINTENANCE'].includes(error.code))
      if (known) {
        try {
          journal.write(operation.userId, null)
          store.setState({ pending: null })
        } catch {}
      }
      store.setState({
        error:
          confirmed && !store.getState().pending
            ? '已保存，刷新失败，请刷新查看。'
            : errorMessage(error),
      })
      if (
        known &&
        error instanceof RoomApiError &&
        ['STALE_CONTEXT', 'FORBIDDEN', 'CONFLICT'].includes(error.code)
      ) {
        try {
          apply(await api.get(state.roomId), token)
        } catch {}
      }
      return confirmed && !store.getState().pending
    } finally {
      if (active(token)) store.setState({ busy: false })
    }
  }
  function submit(command?: DaACommand) {
    if (flight) return flight
    const state = store.getState()
    if (state.busy) return Promise.resolve(false)
    if (
      !acceptClick(
        JSON.stringify([
          state.userId,
          state.roomId,
          state.snapshot?.activity?.activityId ?? 'prepare',
        ]),
      )
    )
      return Promise.resolve(false)
    const current = perform(command)
    flight = current
    void current.finally(() => {
      if (flight === current) flight = null
    })
    return current
  }
  return {
    store,
    open,
    refresh,
    loadMore,
    select,
    submit,
    setOnline(online: boolean) {
      store.setState({ online })
    },
    leave() {
      generation++
      readSerial++
      store.setState({
        roomId: '',
        userId: '',
        snapshot: null,
        pending: null,
        loading: false,
        loadingMore: false,
        busy: false,
        journalReady: false,
      })
    },
  }
}
