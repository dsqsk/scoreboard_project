import { GAME_MODES, createDefaultProfile, isDefaultAvatar } from '@scoreboard/shared'
import type { GameMode } from '@scoreboard/shared'
import type { Me, RoomApi, RoomPreview, RoomReceipt, RoomSnapshot } from './types'
import { isPresetBase } from '../../features/poker/model'
import { RoomApiError } from './errors'

export interface MockStorage {
  read(): unknown
  write(value: unknown): void
}
interface State {
  hiddenRecent?: Record<string, boolean>
  enteredAt?: Record<string, number>
  recentClock?: number
  profile?: Me
  profileReceipts?: Record<string, string>
  version: 1
  rooms: Record<string, RoomSnapshot>
  recentIds: string[]
  receipts: Record<string, { signature: string; receipt: RoomReceipt }>
  nextCode: number
}
interface Options {
  storage: MockStorage
  delayMs?: number
}
const ME: Me = { userId: 'mock-me', displayName: '我', avatarFileId: null, profileCompleted: false }
const now = () => new Date().toISOString()
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
function initial(): State {
  return {
    version: 1,
    recentIds: [],
    receipts: {},
    nextCode: 628392,
    rooms: {
      'mock-example': {
        roomId: 'mock-example',
        name: '周末台球局',
        joinCode: '628391',
        selectedMode: 'kill_ball',
        memberCount: 2,
        status: 'active',
        revision: 1,
        activeActivityId: null,
        members: [
          { userId: 'mock-lin', displayName: '小林', avatarFileId: null, joinedAt: now() },
          { userId: 'mock-zhou', displayName: '小周', avatarFileId: null, joinedAt: now() },
        ],
      },
      'mock-point-example': {
        roomId: 'mock-point-example',
        name: '好友打分局',
        joinCode: '628388',
        selectedMode: 'point_ball',
        memberCount: 2,
        status: 'active',
        revision: 1,
        activeActivityId: null,
        members: ['小林', '小周'].map((displayName, index) => ({
          userId: `mock-point-${index}`,
          displayName,
          joinedAt: now(),
        })),
      },
      ...Object.fromEntries(
        (['da_a', 'dui_jia'] as const).map((mode, i) => {
          const roomId = `mock-poker-${mode}`
          const names = ['小林', '小周', '小陈', '小王'].slice(0, mode === 'da_a' ? 4 : 3)
          return [
            roomId,
            {
              roomId,
              name: mode === 'da_a' ? '好友大A局' : '好友对家局',
              joinCode: i === 0 ? '628389' : '628390',
              selectedMode: mode,
              pokerBase: 5,
              memberCount: names.length,
              status: 'active',
              revision: 1,
              activeActivityId: null,
              members: names.map((displayName, index) => ({
                userId: `mock-poker-${index}`,
                displayName,
                avatarFileId: null,
                joinedAt: now(),
              })),
            },
          ]
        }),
      ),
    },
  }
}
function isState(value: unknown): value is State {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<State>
  return (
    v.version === 1 &&
    !!v.rooms &&
    typeof v.rooms === 'object' &&
    !Array.isArray(v.rooms) &&
    Array.isArray(v.recentIds) &&
    !!v.receipts &&
    typeof v.receipts === 'object' &&
    Number.isSafeInteger(v.nextCode) &&
    Object.values(v.rooms).every(
      (room) =>
        room &&
        typeof room.roomId === 'string' &&
        /^\d{6}$/.test(room.joinCode) &&
        GAME_MODES.includes(room.selectedMode) &&
        Array.isArray(room.members) &&
        room.members.every(
          (member) => typeof member.userId === 'string' && typeof member.displayName === 'string',
        ),
    )
  )
}
export function createMockRoomApi({ storage, delayMs = 280 }: Options): RoomApi & {
  failNext(): void
  loseNextResponse(): void
} {
  let state: State | undefined
  let failure = false
  let lost = false
  // Demo data stays inside this Adapter; UI never synthesizes a successful room.
  function read(): State {
    if (!state) {
      const persisted = storage.read()
      state = isState(persisted) ? clone(persisted) : initial()
      // Add new demo rooms for existing installations without replacing saved rooms or recents.
      for (const [id, fixture] of Object.entries(initial().rooms)) {
        if ((id.startsWith('mock-poker-') || id === 'mock-point-example') && !state.rooms[id])
          state.rooms[id] = fixture
      }
    }
    if (!state.profile || !isDefaultAvatar(state.profile.defaultAvatar)) {
      const next = clone(state)
      const generated = createDefaultProfile()
      next.profile = {
        ...ME,
        ...next.profile,
        defaultAvatar: generated.defaultAvatar,
        displayName:
          next.profile?.displayName && next.profile.displayName !== '微信用户'
            ? next.profile.displayName
            : generated.displayName,
        profileCompleted: true,
      }
      for (const room of Object.values(next.rooms))
        for (const member of room.members)
          if (member.userId === ME.userId) Object.assign(member, next.profile)
      commit(next)
    }
    return state
  }
  function visit(next: State, roomId: string) {
    const time = Math.max(Date.now(), (next.recentClock ?? 0) + 1)
    next.recentClock = time
    next.enteredAt = { ...next.enteredAt, [roomId]: time }
    next.hiddenRecent = { ...next.hiddenRecent, [roomId]: false }
    next.recentIds = [roomId, ...next.recentIds.filter((id) => id !== roomId)]
  }
  function visible() {
    const data = read()
    return data.recentIds.flatMap((id, index) => {
      const room = data.rooms[id]
      return room?.status === 'active' &&
        !data.hiddenRecent?.[id] &&
        room.members.some((member) => member.userId === ME.userId)
        ? [
            {
              ...preview(room),
              lastEnteredAt: data.enteredAt?.[id] ?? data.recentIds.length - index,
            },
          ]
        : []
    })
  }
  async function pause() {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (failure) {
      failure = false
      throw new RoomApiError('INTERNAL_ERROR', '演示请求失败，请重试')
    }
  }
  function commit(next: State) {
    storage.write(next) // A failed write must not become a visible success.
    state = next
  }
  function findByCode(code: string): RoomSnapshot {
    const room = Object.values(read().rooms).find((item) => item.joinCode === code)
    if (!room) throw new RoomApiError('NOT_FOUND', '未找到这个房间，请检查房间码')
    if (room.status !== 'active') throw new RoomApiError('FORBIDDEN', '这个房间已关闭')
    return room
  }
  function preview(room: RoomSnapshot): RoomPreview {
    const { members: _members, revision: _revision, activeActivityId: _activity, ...rest } = room
    return clone(rest)
  }
  function previous(requestId: string, signature: string) {
    const record = read().receipts[requestId]
    if (record && record.signature !== signature)
      throw new RoomApiError('CONFLICT', '该请求已用于其他操作，请重新操作')
    return record?.receipt
  }
  function maybeLoseResponse() {
    if (lost) {
      lost = false
      throw new RoomApiError('TRANSPORT_UNKNOWN', '请求结果待确认，请使用原请求重试')
    }
  }
  async function create(mode: GameMode, requestId: string, base?: number) {
    await pause()
    if (!GAME_MODES.includes(mode)) throw new RoomApiError('INVALID_ARGUMENT', '请先选择游戏模式')
    const signature = base === undefined ? `create:${mode}` : `create:${mode}@${base}`
    const old = previous(requestId, signature)
    if (old) return clone(old)
    const next = clone(read())
    if (next.nextCode > 999999) throw new RoomApiError('INTERNAL_ERROR', '演示房间数量已达上限')
    const code = String(next.nextCode++)
    const roomId = `mock-room-${code}`
    next.rooms[roomId] = {
      roomId,
      name:
        mode === 'da_a'
          ? '好友大A局'
          : mode === 'dui_jia'
            ? '好友对家局'
            : mode === 'point_ball'
              ? '好友打分局'
              : '朋友的房间',
      joinCode: code,
      selectedMode: mode,
      memberCount: 1,
      status: 'active',
      revision: 1,
      activeActivityId: null,
      members: [{ ...(read().profile ?? ME), joinedAt: now() }],
      ...(base === undefined ? {} : { pokerBase: base }),
    }
    const receipt = { roomId, requestId }
    next.receipts[requestId] = { signature, receipt }
    visit(next, roomId)
    commit(next)
    maybeLoseResponse()
    return clone(receipt)
  }

  return {
    failNext() {
      failure = true
    },
    loseNextResponse() {
      lost = true
    },
    async getMe() {
      await pause()
      return clone(read().profile ?? ME)
    },
    async updateProfile(input, requestId) {
      await pause()
      const displayName = input.displayName.trim()
      if (
        !displayName ||
        displayName.length > 32 ||
        (input.avatarFileId !== undefined &&
          !input.avatarFileId.startsWith(`cloud://mock/avatars/${ME.userId}/`))
      )
        throw new RoomApiError('INVALID_ARGUMENT', '请填写昵称并选择有效头像')
      const next = clone(read())
      const signature = JSON.stringify([displayName, input.avatarFileId ?? null])
      if (next.profileReceipts?.[requestId]) {
        if (next.profileReceipts[requestId] !== signature)
          throw new RoomApiError('IDEMPOTENCY_MISMATCH', '请求已用于其他资料')
        return
      }
      next.profile = {
        ...(next.profile ?? ME),
        displayName,
        ...(input.avatarFileId ? { avatarFileId: input.avatarFileId } : {}),
        profileCompleted: true,
      }
      next.profileReceipts = { ...next.profileReceipts, [requestId]: signature }
      for (const room of Object.values(next.rooms))
        for (const member of room.members)
          if (member.userId === ME.userId) Object.assign(member, next.profile)
      commit(next)
      maybeLoseResponse()
    },
    createRoom: (mode, requestId) => create(mode, requestId),
    async createPokerRoom(mode, base, requestId) {
      if (!['da_a', 'dui_jia'].includes(mode) || !isPresetBase(base))
        throw new RoomApiError('RULE_NOT_CONFIGURED', '请使用预设底分1、5或10；自定义规则尚未确定')
      return create(mode, requestId, base)
    },
    async previewRoom(code: string) {
      await pause()
      return preview(findByCode(code))
    },
    async joinRoom(code: string, requestId: string) {
      await pause()
      const signature = `join:${code}`
      const old = previous(requestId, signature)
      if (old) return clone(old)
      const source = findByCode(code)
      const next = clone(read())
      const room = next.rooms[source.roomId]
      if (!room.members.some((member) => member.userId === ME.userId)) {
        room.members.push({ ...(read().profile ?? ME), joinedAt: now() })
        room.memberCount = room.members.length
        room.revision++
      }
      const receipt = { roomId: room.roomId, requestId }
      next.receipts[requestId] = { signature, receipt }
      visit(next, room.roomId)
      commit(next)
      maybeLoseResponse()
      return clone(receipt)
    },
    async listRecent() {
      await pause()
      return clone(visible().slice(0, 20))
    },
    async listRecentPage(cursor, limit = 20) {
      await pause()
      if (!Number.isInteger(limit) || limit < 1 || limit > 20)
        throw new RoomApiError('INVALID_ARGUMENT', '分页数量不正确')
      let rooms = visible()
      if (cursor) {
        const match = /^mock_(\d+)_(.+)$/.exec(cursor)
        if (!match) throw new RoomApiError('INVALID_ARGUMENT', '分页已失效，请刷新')
        const time = Number(match[1])
        const id = match[2]!
        rooms = rooms.filter(
          (room) => room.lastEnteredAt < time || (room.lastEnteredAt === time && room.roomId > id),
        )
      }
      const page = rooms.slice(0, limit)
      const last = page.at(-1)
      return clone({
        rooms: page,
        nextCursor:
          rooms.length > limit && last ? `mock_${last.lastEnteredAt}_${last.roomId}` : null,
      })
    },
    async enterRoom(roomId, requestId) {
      await pause()
      const signature = `enter:${roomId}`
      const old = previous(requestId, signature)
      if (old) return clone(old)
      const source = read().rooms[roomId]
      if (!source) throw new RoomApiError('NOT_FOUND', '房间不存在')
      if (
        source.status !== 'active' ||
        !source.members.some((member) => member.userId === ME.userId)
      )
        throw new RoomApiError('FORBIDDEN', '请先加入这个房间')
      const next = clone(read())
      visit(next, roomId)
      const receipt = { roomId, requestId }
      next.receipts[requestId] = { signature, receipt }
      commit(next)
      maybeLoseResponse()
      return clone(receipt)
    },
    async dismissRecentRoom(roomId, requestId) {
      await pause()
      const signature = `dismiss:${roomId}`
      const old = previous(requestId, signature)
      if (old) return clone(old)
      if (!read().rooms[roomId]?.members.some((member) => member.userId === ME.userId))
        throw new RoomApiError('FORBIDDEN', '请先加入这个房间')
      const next = clone(read())
      next.hiddenRecent = { ...next.hiddenRecent, [roomId]: true }
      const receipt = { roomId, requestId }
      next.receipts[requestId] = { signature, receipt }
      commit(next)
      maybeLoseResponse()
      return clone(receipt)
    },
    async getRoomSnapshot(roomId: string) {
      await pause()
      const room = read().rooms[roomId]
      if (!room) throw new RoomApiError('NOT_FOUND', '房间不存在')
      if (room.status !== 'active') throw new RoomApiError('FORBIDDEN', '这个房间已关闭')
      if (!room.members.some((member) => member.userId === ME.userId))
        throw new RoomApiError('FORBIDDEN', '请先加入房间')
      return clone(room)
    },
  }
}
