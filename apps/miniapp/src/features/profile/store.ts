import { isPersistentAvatar } from './http-avatars'
import { createStore } from 'zustand/vanilla'
import type { Me } from '../../modules/room-api/types'
import { RoomApiError, errorMessage } from '../../modules/room-api/errors'
export interface ProfileInput {
  displayName: string
  avatarFileId?: string
}
export interface ProfilePending extends ProfileInput {
  userId: string
  requestId: string
}
export interface ProfilePorts {
  upload(userId: string, path: string): Promise<string>
  update(input: ProfileInput, requestId: string): Promise<void>
  reload(): Promise<Me>
  read(userId: string): ProfilePending | null
  write(userId: string, pending: ProfilePending | null): void
  makeId(): string
}
export function createProfileStore(ports: ProfilePorts) {
  const store = createStore<{
    userId: string | null
    name: string
    avatar: string
    localPath: string
    defaultAvatar: Me['defaultAvatar']
    phase: 'idle' | 'uploading' | 'saving' | 'unknown'
    error: string | null
    pending: ProfilePending | null
  }>(() => ({
    userId: null,
    name: '',
    avatar: '',
    localPath: '',
    defaultAvatar: undefined,
    phase: 'idle',
    error: null,
    pending: null,
  }))
  function open(me: Me) {
    if (store.getState().userId === me.userId) return
    try {
      const pending = ports.read(me.userId)
      if (
        pending &&
        (pending.userId !== me.userId ||
          !pending.requestId ||
          (pending.avatarFileId !== undefined && !isPersistentAvatar(pending.avatarFileId)) ||
          !pending.displayName.trim())
      )
        throw new Error('待确认资料无法读取，请保留本地数据并重试')
      store.setState({
        userId: me.userId,
        name: pending?.displayName ?? (me.profileCompleted ? me.displayName : ''),
        avatar: pending?.avatarFileId ?? me.avatarFileId ?? '',
        defaultAvatar: me.defaultAvatar,
        localPath: '',
        phase: pending ? 'unknown' : 'idle',
        pending,
        error: null,
      })
    } catch (error) {
      store.setState({
        userId: me.userId,
        phase: 'unknown',
        error: errorMessage(error),
        pending: null,
      })
    }
  }
  function name(value: string) {
    if (store.getState().phase === 'idle') store.setState({ name: value, error: null })
  }
  function choose(path: string) {
    if (store.getState().phase === 'idle')
      store.setState({ localPath: path, avatar: '', error: null })
  }
  async function save(): Promise<boolean> {
    const state = store.getState()
    if (!state.userId || state.phase === 'uploading' || state.phase === 'saving') return false
    if (state.phase === 'unknown' && !state.pending) return false
    let pending = state.pending
    let sent = false
    try {
      if (!pending) {
        const displayName = state.name.trim()
        if (!displayName || displayName.length > 32) throw new Error('请填写1～32个字符的昵称')
        let avatarFileId = state.avatar
        if (!avatarFileId && !state.localPath && !state.defaultAvatar)
          throw new Error('默认头像尚未就绪，请重新读取资料')
        if (!avatarFileId && state.localPath) {
          store.setState({ phase: 'uploading', error: null })
          avatarFileId = await ports.upload(state.userId, state.localPath)
          if (!isPersistentAvatar(avatarFileId)) throw new Error('头像上传结果异常，请重新选择')
          store.setState({ avatar: avatarFileId, localPath: '' })
        }
        pending = {
          userId: state.userId,
          requestId: ports.makeId(),
          displayName,
          ...(avatarFileId ? { avatarFileId } : {}),
        }
        ports.write(state.userId, pending)
        store.setState({ pending })
      }
      store.setState({ phase: 'saving', error: null })
      sent = true
      await ports.update(
        {
          displayName: pending.displayName,
          ...(pending.avatarFileId ? { avatarFileId: pending.avatarFileId } : {}),
        },
        pending.requestId,
      )
      const me = await ports.reload()
      if (!me.profileCompleted || me.userId !== pending.userId)
        throw new RoomApiError('INVALID_RESPONSE', '资料尚未确认，请重试确认原保存')
      ports.write(pending.userId, null)
      store.setState({
        name: me.displayName,
        avatar: me.avatarFileId ?? '',
        defaultAvatar: me.defaultAvatar,
        localPath: '',
        pending: null,
        phase: 'idle',
        error: null,
      })
      return true
    } catch (error) {
      const unknown =
        sent &&
        (!(error instanceof RoomApiError) ||
          ['TRANSPORT_UNKNOWN', 'INVALID_RESPONSE', 'MAINTENANCE'].includes(error.code))
      if (!unknown && pending) {
        try {
          ports.write(pending.userId, null)
        } catch {}
      }
      store.setState({
        phase: unknown ? 'unknown' : 'idle',
        pending: unknown ? pending : null,
        error: errorMessage(error),
      })
      return false
    }
  }
  return { store, open, name, choose, save }
}
