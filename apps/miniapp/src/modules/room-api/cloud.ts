import { GAME_MODES, foundationRequestSchema } from '@scoreboard/shared'
import type { FoundationRequest, Me } from '@scoreboard/shared'
import type { RoomApi, RoomPreview, RoomReceipt, RoomSnapshot, RoomMember } from './types'
import { RoomApiError } from './errors'

type RecordValue = Record<string, unknown>
export interface CloudTransport {
  init(env: string): void | Promise<void>
  call(data: FoundationRequest): Promise<unknown>
}
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object'
const me = (v: unknown): v is Me =>
  object(v) &&
  typeof v.userId === 'string' &&
  typeof v.displayName === 'string' &&
  (v.avatarFileId === undefined || v.avatarFileId === null || typeof v.avatarFileId === 'string') &&
  (v.defaultAvatar === undefined ||
    (object(v.defaultAvatar) &&
      v.defaultAvatar.template === 'person-v1' &&
      typeof v.defaultAvatar.color === 'string' &&
      /^#[0-9a-f]{6}$/i.test(v.defaultAvatar.color)))
const member = (v: unknown): v is RoomMember =>
  me(v) && object(v) && typeof v.joinedAt === 'string' && Number.isFinite(Date.parse(v.joinedAt))
function isPreview(v: unknown): v is RoomPreview {
  return (
    object(v) &&
    typeof v.roomId === 'string' &&
    typeof v.name === 'string' &&
    typeof v.joinCode === 'string' &&
    /^\d{6}$/.test(v.joinCode) &&
    GAME_MODES.some((mode) => mode === v.selectedMode) &&
    Number.isSafeInteger(v.memberCount) &&
    Number(v.memberCount) >= 0 &&
    (v.status === 'active' || v.status === 'closed')
  )
}
function toPreview(value: RoomPreview): RoomPreview {
  const { roomId, name, joinCode, selectedMode, memberCount, status } = value
  return { roomId, name, joinCode, selectedMode, memberCount, status }
}
export function createCloudRoomApi(env: string, transport: CloudTransport): RoomApi {
  let initialized = false
  async function call(request: FoundationRequest): Promise<unknown> {
    if (!env) throw new RoomApiError('INTERNAL_ERROR', '未配置微信云环境')
    // WeChat cannot execute Zod's dynamically generated parser functions.
    const data = foundationRequestSchema.parse(request, { jitless: true })
    if (!initialized) {
      await transport.init(env)
      initialized = true
    }
    let result: unknown
    try {
      result = await transport.call(data)
    } catch {
      throw new RoomApiError(
        'TRANSPORT_UNKNOWN',
        'requestId' in request ? '请求结果待确认，请使用原请求重试' : '连接失败，请重试',
      )
    }
    if (object(result) && result.ok === false && object(result.error)) {
      const error = result.error
      const codes = [
        'INVALID_ARGUMENT',
        'UNAUTHENTICATED',
        'MAINTENANCE',
        'FORBIDDEN',
        'NOT_FOUND',
        'CONFLICT',
        'INTERNAL_ERROR',
        'STALE_CONTEXT',
        'RULE_NOT_CONFIGURED',
        'IDEMPOTENCY_MISMATCH',
        'RATE_LIMITED',
        'ALREADY_POSTED',
      ] as const
      const code = codes.find((item) => item === error.code)
      throw new RoomApiError(
        code ?? 'INTERNAL_ERROR',
        typeof error.message === 'string' ? error.message : '服务暂时不可用',
      )
    }
    if (!object(result) || result.ok !== true)
      throw new RoomApiError('INVALID_RESPONSE', '服务返回异常，请重试确认结果')
    return result.data
  }
  function receipt(value: unknown, expectedRequestId: string): RoomReceipt {
    if (!object(value) || typeof value.roomId !== 'string' || value.requestId !== expectedRequestId)
      throw new RoomApiError('INVALID_RESPONSE', '房间结果异常，请使用原请求确认')
    return { roomId: value.roomId, requestId: expectedRequestId }
  }
  return {
    async getMe() {
      const value = await call({ action: 'identity.getMe', payload: {} })
      if (!me(value)) throw new RoomApiError('INVALID_RESPONSE', '用户信息返回异常')
      return {
        userId: value.userId,
        displayName: value.displayName,
        avatarFileId: value.avatarFileId ?? null,
        ...(value.defaultAvatar ? { defaultAvatar: value.defaultAvatar } : {}),
        profileCompleted: value.profileCompleted === true,
      }
    },
    async updateProfile(input, requestId) {
      const value = await call({ action: 'identity.updateProfile', requestId, payload: input })
      if (!object(value) || value.requestId !== requestId || typeof value.entityId !== 'string')
        throw new RoomApiError('INVALID_RESPONSE', '资料保存结果待确认，请重试原操作')
    },
    async createPokerRoom(mode, base, requestId) {
      if (mode !== 'da_a') throw new RoomApiError('RULE_NOT_CONFIGURED', '云端打对家创建尚未接入')
      if (base !== 1 && base !== 5 && base !== 10)
        throw new RoomApiError('INVALID_ARGUMENT', '请选择底分1、5或10')
      return receipt(
        await call({ action: 'daA.createRoom', requestId, payload: { baseStake: base } }),
        requestId,
      )
    },
    async createRoom(mode, requestId) {
      return receipt(await call({ action: 'room.create', requestId, payload: { mode } }), requestId)
    },
    async previewRoom(joinCode) {
      const value = await call({ action: 'room.preview', payload: { joinCode } })
      if (!isPreview(value)) throw new RoomApiError('INVALID_RESPONSE', '房间信息返回异常')
      return toPreview(value)
    },
    async joinRoom(joinCode, requestId) {
      return receipt(
        await call({ action: 'room.join', requestId, payload: { joinCode } }),
        requestId,
      )
    },
    async enterRoom(roomId, requestId) {
      const value = receipt(
        await call({ action: 'room.enter', requestId, payload: { roomId } }),
        requestId,
      )
      if (value.roomId !== roomId)
        throw new RoomApiError('INVALID_RESPONSE', '进入结果待确认，请使用原请求重试')
      return value
    },
    async dismissRecentRoom(roomId, requestId) {
      const value = receipt(
        await call({ action: 'room.dismissRecent', requestId, payload: { roomId } }),
        requestId,
      )
      if (value.roomId !== roomId)
        throw new RoomApiError('INVALID_RESPONSE', '移除结果待确认，请使用原请求重试')
      return value
    },
    async listRecentPage(cursor, limit = 20) {
      const value = await call({
        action: 'room.listRecentPage',
        payload: { ...(cursor ? { cursor } : {}), limit },
      })
      if (
        !object(value) ||
        !Array.isArray(value.rooms) ||
        !value.rooms.every(
          (v) =>
            isPreview(v) &&
            object(v) &&
            Number.isSafeInteger(v.lastEnteredAt) &&
            Number(v.lastEnteredAt) >= 0,
        ) ||
        !(
          value.nextCursor === null ||
          (typeof value.nextCursor === 'string' && value.nextCursor.length > 0)
        )
      )
        throw new RoomApiError('INVALID_RESPONSE', '最近房间分页返回异常，请重试')
      return {
        rooms: value.rooms.map((v) => ({
          ...toPreview(v),
          lastEnteredAt: Number(v.lastEnteredAt),
        })),
        nextCursor: value.nextCursor as string | null,
      }
    },
    async listRecent() {
      const value = await call({ action: 'room.listRecent', payload: {} })
      if (!Array.isArray(value) || !value.every(isPreview))
        throw new RoomApiError('INVALID_RESPONSE', '最近房间返回异常')
      return value.map(toPreview)
    },
    async getRoomSnapshot(roomId): Promise<RoomSnapshot> {
      const value = await call({ action: 'room.getSnapshot', payload: { roomId } })
      if (
        !isPreview(value) ||
        !object(value) ||
        !Number.isSafeInteger(value.revision) ||
        !(value.activeActivityId === null || typeof value.activeActivityId === 'string') ||
        !Array.isArray(value.members) ||
        !value.members.every(member) ||
        !(
          value.membersNextCursor === undefined ||
          value.membersNextCursor === null ||
          typeof value.membersNextCursor === 'string'
        )
      )
        throw new RoomApiError('INVALID_RESPONSE', '房间快照返回异常')
      const members = [...value.members]
      let cursor = typeof value.membersNextCursor === 'string' ? value.membersNextCursor : undefined
      const cursors = new Set<string>()
      while (cursor) {
        if (cursors.has(cursor)) throw new RoomApiError('INVALID_RESPONSE', '成员分页异常，请刷新')
        cursors.add(cursor)
        const page = await call({
          action: 'room.listMembers',
          payload: { roomId, limit: 20, cursor },
        })
        if (
          !object(page) ||
          !Array.isArray(page.members) ||
          !page.members.every(member) ||
          !(page.nextCursor === null || typeof page.nextCursor === 'string')
        )
          throw new RoomApiError('INVALID_RESPONSE', '成员信息返回异常')
        members.push(...page.members)
        cursor = page.nextCursor ?? undefined
      }
      return {
        ...toPreview(value),
        members: members.map((item) => ({
          userId: item.userId,
          displayName: item.displayName,
          avatarFileId: item.avatarFileId ?? null,
          ...(item.defaultAvatar ? { defaultAvatar: item.defaultAvatar } : {}),
          joinedAt: item.joinedAt,
        })),
        revision: Number(value.revision),
        activeActivityId: value.activeActivityId as string | null,
      }
    },
  }
}
