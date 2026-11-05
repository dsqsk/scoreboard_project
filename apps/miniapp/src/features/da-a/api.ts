import { daARequestSchema, DA_A_BASE_STAKES, DA_A_VALUES } from '@scoreboard/shared'
import type { DaARequest, DaASnapshot, CommandReceipt } from '@scoreboard/shared'
import { RoomApiError } from '../../modules/room-api/errors'
export type { DaASnapshot }
export type DaACommand =
  | { kind: 'prepare'; expectedRoomRevision: number; participantIds: string[] }
  | {
      kind: 'delta'
      activityId: string
      expectedConfigRevision: number
      direction: 1 | -1
      value: (typeof DA_A_VALUES)[number]
      mingA: boolean
    }
export interface DaAApi {
  get(roomId: string, cursor?: string): Promise<DaASnapshot>
  execute(roomId: string, command: DaACommand, requestId: string): Promise<CommandReceipt>
}
export function requestFor(roomId: string, command: DaACommand, requestId: string): DaARequest {
  const { kind, ...payload } = command
  return daARequestSchema.parse(
    {
      action: kind === 'prepare' ? 'daA.prepare' : 'daA.addDelta',
      requestId,
      payload: { roomId, ...payload },
    },
    { jitless: true },
  )
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const integer = (value: unknown): value is number => Number.isSafeInteger(value)
const revision = (value: unknown) => integer(value) && value >= 0
export function isDaASnapshot(value: unknown): value is DaASnapshot {
  if (
    !object(value) ||
    !text(value.roomId) ||
    !revision(value.roomRevision) ||
    !DA_A_BASE_STAKES.includes(value.baseStake as 1) ||
    value.scoreScale !== 100 ||
    typeof value.canRecord !== 'boolean' ||
    !object(value.totalsUnits) ||
    !Object.values(value.totalsUnits).every(integer) ||
    !(value.nextCursor === null || text(value.nextCursor)) ||
    !Array.isArray(value.entries)
  )
    return false
  if (value.activity !== null) {
    const a = value.activity
    if (
      !object(a) ||
      !text(a.activityId) ||
      !revision(a.configRevision) ||
      !revision(a.revision) ||
      !['open', 'posted', 'archived'].includes(String(a.status)) ||
      !Array.isArray(a.participants) ||
      a.participants.length !== 5 ||
      !a.participants.every((p) => object(p) && text(p.userId) && text(p.displayName)) ||
      new Set(a.participants.map((p) => p.userId)).size !== 5 ||
      (value.canRecord && a.status !== 'open')
    )
      return false
  } else if (value.canRecord) return false
  const seen = new Set<string>()
  return value.entries.every((e) => {
    if (
      !object(e) ||
      !text(e.entryId) ||
      seen.has(e.entryId) ||
      !text(e.requestId) ||
      e.roomId !== value.roomId ||
      !text(e.activityId) ||
      !text(e.userId) ||
      !text(e.displayName) ||
      !(e.direction === 1 || e.direction === -1) ||
      !DA_A_VALUES.includes(e.value as 1) ||
      !DA_A_BASE_STAKES.includes(e.baseStake as 1) ||
      typeof e.mingA !== 'boolean' ||
      !integer(e.deltaUnits) ||
      !revision(e.savedAt) ||
      e.deltaUnits !==
        Number(e.direction) * Number(e.value) * Number(e.baseStake) * (e.mingA ? 2 : 1) * 100
    )
      return false
    seen.add(e.entryId)
    return true
  })
}
export function formatUnits(units: number): string {
  if (!Number.isSafeInteger(units)) return '—'
  const absolute = Math.abs(units)
  const fraction = absolute % 100
  return `${units < 0 ? '-' : ''}${Math.floor(absolute / 100)}${fraction ? `.${String(fraction).padStart(2, '0').replace(/0$/, '')}` : ''}`
}
export const signedUnits = (units: number) => `${units > 0 ? '+' : ''}${formatUnits(units)}`
export function createCloudDaAApi(transport: (request: DaARequest) => Promise<unknown>): DaAApi {
  async function call(request: DaARequest) {
    const parsed = daARequestSchema.parse(request, { jitless: true })
    let response: unknown
    try {
      response = await transport(parsed)
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
        codes.find((c) => c === (response.error as Record<string, unknown>).code) ??
          'INTERNAL_ERROR',
        typeof response.error.message === 'string' ? response.error.message : '请求失败',
      )
    }
    if (!object(response) || response.ok !== true)
      throw new RoomApiError('INVALID_RESPONSE', '服务响应异常，请确认原操作')
    return response.data
  }
  return {
    async get(roomId, cursor) {
      const value = await call({
        action: 'daA.getState',
        payload: { roomId, ...(cursor ? { cursor } : {}) },
      })
      if (!isDaASnapshot(value) || value.roomId !== roomId)
        throw new RoomApiError('INVALID_RESPONSE', '打大A状态异常，未更新页面')
      return value
    },
    async execute(roomId, command, requestId) {
      const value = await call(requestFor(roomId, command, requestId))
      if (
        !object(value) ||
        value.roomId !== roomId ||
        value.requestId !== requestId ||
        !text(value.entityId) ||
        !text(value.activityId) ||
        (command.kind === 'delta' && value.activityId !== command.activityId)
      )
        throw new RoomApiError('INVALID_RESPONSE', '保存回执异常，请确认原操作')
      return value as unknown as CommandReceipt
    },
  }
}
