import { isPointReceipt } from './receipt'
import { foundationRequestSchema } from '@scoreboard/shared'
import type { FoundationRequest } from '@scoreboard/shared'
import { RoomApiError } from '../../modules/room-api/errors'
import type { PointApi, PointSnapshot, PointResult, PointChange, Participant } from './api'
interface Transport {
  init(env: string): void | Promise<void>
  call(request: FoundationRequest): Promise<unknown>
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const revision = (v: unknown): v is number => integer(v) && v >= 0
const nullableId = (v: unknown) => v === null || (typeof v === 'string' && v.length > 0)
const numericMap = (v: unknown): v is Record<string, number> =>
  object(v) && Object.values(v).every(integer)
const participants = (v: unknown): v is Participant[] =>
  Array.isArray(v) &&
  (v.length === 2 || v.length === 3) &&
  v.every((p) => object(p) && typeof p.userId === 'string' && typeof p.displayName === 'string') &&
  new Set(v.map((p) => p.userId)).size === v.length
function result(v: unknown): v is PointResult {
  if (
    !object(v) ||
    typeof v.activityId !== 'string' ||
    !participants(v.participants) ||
    !numericMap(v.earnedPoints) ||
    !numericMap(v.deltas) ||
    !revision(v.savedAt)
  )
    return false
  const points = v.earnedPoints
  const deltas = v.deltas
  const baseline = 120 / v.participants.length
  return (
    v.participants.every(
      (p) =>
        integer(points[p.userId]) &&
        points[p.userId]! >= 0 &&
        points[p.userId]! <= 120 &&
        deltas[p.userId] === points[p.userId]! - baseline,
    ) && v.participants.reduce((sum, p) => sum + points[p.userId]!, 0) === 120
  )
}
function change(v: unknown): v is PointChange {
  return (
    object(v) &&
    typeof v.requestId === 'string' &&
    integer(v.number) &&
    v.number >= 1 &&
    v.number <= 15 &&
    nullableId(v.fromUserId) &&
    nullableId(v.toUserId) &&
    typeof v.actorUserId === 'string' &&
    typeof v.actorName === 'string' &&
    revision(v.createdAt)
  )
}
export function isPointSnapshot(v: unknown): v is PointSnapshot {
  if (
    !object(v) ||
    typeof v.roomId !== 'string' ||
    !revision(v.roomRevision) ||
    !numericMap(v.totals) ||
    !Array.isArray(v.results) ||
    !v.results.every(result) ||
    !nullableId(v.nextResultCursor) ||
    !nullableId(v.nextChangeCursor)
  )
    return false
  if (v.activity === null) return true
  const a = v.activity
  if (
    !object(a) ||
    typeof a.activityId !== 'string' ||
    !revision(a.revision) ||
    !['open', 'posted'].includes(String(a.status)) ||
    !participants(a.participants) ||
    !numericMap(a.earnedPoints) ||
    !Array.isArray(a.cards) ||
    a.cards.length !== 15 ||
    !Array.isArray(a.changes) ||
    !a.changes.every(change) ||
    !(a.result === null || result(a.result))
  )
    return false
  const ids = a.participants.map((p) => p.userId)
  const points: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]))
  const seen = new Set<number>()
  for (const card of a.cards) {
    if (
      !object(card) ||
      !integer(card.number) ||
      card.number < 1 ||
      card.number > 15 ||
      seen.has(card.number) ||
      !revision(card.revision) ||
      !nullableId(card.ownerUserId) ||
      !nullableId(card.initialRecordedBy) ||
      !nullableId(card.lastModifiedBy)
    )
      return false
    seen.add(card.number)
    if (card.ownerUserId !== null) {
      if (typeof card.ownerUserId !== 'string' || !ids.includes(card.ownerUserId)) return false
      points[card.ownerUserId]! += card.number
    }
  }
  if (
    !ids.every(
      (id) => a.earnedPoints && (a.earnedPoints as Record<string, number>)[id] === points[id],
    )
  )
    return false
  return a.status === 'posted'
    ? a.result !== null &&
        (a.result as PointResult).activityId === a.activityId &&
        ids.every((id) => (a.result as PointResult).earnedPoints[id] === points[id])
    : a.result === null
}
export function createCloudPointApi(env: string, transport: Transport): PointApi {
  let initialized = false
  async function call(request: FoundationRequest): Promise<unknown> {
    if (!env) throw new RoomApiError('INTERNAL_ERROR', '未配置微信云环境')
    // Keep request validation compatible with WeChat's restricted Function runtime.
    const parsed = foundationRequestSchema.parse(request, { jitless: true })
    if (!initialized) {
      await transport.init(env)
      initialized = true
    }
    let response: unknown
    try {
      response = await transport.call(parsed)
    } catch {
      throw new RoomApiError(
        'TRANSPORT_UNKNOWN',
        'requestId' in request ? '保存结果待确认，请确认原操作' : '连接失败，请刷新重试',
      )
    }
    if (object(response) && response.ok === false && object(response.error)) {
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
      throw new RoomApiError(
        codes.find((code) => code === (response.error as Record<string, unknown>).code) ??
          'INTERNAL_ERROR',
        typeof response.error.message === 'string' ? response.error.message : '请求失败，请重试',
      )
    }
    if (!object(response) || response.ok !== true)
      throw new RoomApiError('INVALID_RESPONSE', '服务响应异常，请重新确认结果')
    return response.data
  }
  return {
    async get(roomId, page = {}) {
      const response = await call({ action: 'point.getState', payload: { roomId, ...page } })
      if (!isPointSnapshot(response) || response.roomId !== roomId)
        throw new RoomApiError('INVALID_RESPONSE', '打分状态异常，未更新页面')
      return response
    },
    async execute(roomId, command, requestId) {
      let request: FoundationRequest
      if (command.kind === 'prepare')
        request = {
          action: 'activity.prepare',
          requestId,
          payload: {
            roomId,
            expectedRoomRevision: command.expectedRoomRevision,
            participantIds: command.participantIds,
            configInput: {},
          },
        }
      else if (command.kind === 'claim') {
        const { kind: _kind, ...payload } = command
        request = { action: 'point.claim', requestId, payload: { roomId, ...payload } }
      } else if (command.kind === 'correct') {
        const { kind: _kind, ...payload } = command
        request = { action: 'point.correct', requestId, payload: { roomId, ...payload } }
      } else {
        const { kind: _kind, ...payload } = command
        request = { action: 'point.post', requestId, payload: { roomId, ...payload } }
      }
      const receipt = await call(request)
      if (!isPointReceipt(receipt, roomId, command, requestId))
        throw new RoomApiError('INVALID_RESPONSE', '写入回执异常，请确认原操作')
      return receipt
    },
  }
}
