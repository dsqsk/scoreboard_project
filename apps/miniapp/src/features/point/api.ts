import type { RoomApi } from '../../modules/room-api/types'
import type { MockStorage } from '../../modules/room-api/mock'
import { RoomApiError } from '../../modules/room-api/errors'
import type {
  CommandReceipt,
  PointSnapshot,
  PointParticipant,
  PointCardDTO,
  PointChange,
  PointResult,
} from '@scoreboard/shared'
export type { PointSnapshot, PointChange, PointResult }
export type Participant = PointParticipant
export type PointCard = PointCardDTO
export type PointActivity = NonNullable<PointSnapshot['activity']>
export interface PointPage {
  resultCursor?: string
  changeCursor?: string
}
export type PointCommand =
  | { kind: 'prepare'; expectedRoomRevision: number; participantIds: string[] }
  | { kind: 'claim'; activityId: string; number: number; expectedCardRevision: number }
  | {
      kind: 'correct'
      activityId: string
      number: number
      expectedCardRevision: number
      ownerUserId: string | null
    }
  | { kind: 'post'; activityId: string; expectedActivityRevision: number }
export interface PointApi {
  get(roomId: string, page?: PointPage): Promise<PointSnapshot>
  execute(roomId: string, command: PointCommand, requestId: string): Promise<CommandReceipt | void>
}
interface RoomData {
  sequence: number
  activity: PointActivity | null
  results: PointResult[]
}
interface Data {
  version: 1
  rooms: Record<string, RoomData>
  receipts: Record<string, string | { signature: string; receipt: CommandReceipt }>
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const fail = (code: ConstructorParameters<typeof RoomApiError>[0], message: string): never => {
  throw new RoomApiError(code, message)
}
function earned(activity: PointActivity) {
  return Object.fromEntries(
    activity.participants.map((p) => [
      p.userId,
      activity.cards
        .filter((c) => c.ownerUserId === p.userId)
        .reduce((sum, card) => sum + card.number, 0),
    ]),
  )
}
export function createMockPointApi(
  roomApi: RoomApi,
  storage: MockStorage,
): PointApi & { failNext(): void; loseNextResponse(): void } {
  let failure = false
  let lost = false
  function read(): Data {
    const value = storage.read()
    if (!value) return { version: 1, rooms: {}, receipts: {} }
    const data = value as Data
    if (data.version !== 1 || !data.rooms || !data.receipts)
      return fail('INVALID_RESPONSE', '打分数据无法读取，请保留本地数据并检查')
    return clone(data)
  }
  async function context(roomId: string) {
    const [me, room] = await Promise.all([roomApi.getMe(), roomApi.getRoomSnapshot(roomId)])
    if (room.status !== 'active' || !room.members.some((m) => m.userId === me.userId))
      return fail('FORBIDDEN', '请先加入这个房间')
    if (room.selectedMode !== 'point_ball')
      return fail('STALE_CONTEXT', '房间玩法已变化，请重新进入')
    return { me, room }
  }
  return {
    failNext() {
      failure = true
    },
    loseNextResponse() {
      lost = true
    },
    async get(roomId, page = {}) {
      const { room } = await context(roomId)
      const data = read().rooms[roomId] ?? { sequence: 0, activity: null, results: [] }
      const totals: Record<string, number> = Object.fromEntries(
        room.members.map((m) => [m.userId, 0]),
      )
      for (const result of data.results)
        for (const [id, delta] of Object.entries(result.deltas))
          totals[id] = (totals[id] ?? 0) + delta
      const resultStart = page.resultCursor
        ? data.results.findIndex((r) => r.activityId === page.resultCursor)
        : 0
      const changeStart = page.changeCursor
        ? (data.activity?.changes.findIndex((c) => c.requestId === page.changeCursor) ?? -1)
        : 0
      if (resultStart < 0) return fail('INVALID_ARGUMENT', '结果分页已失效，请刷新记录')
      if (changeStart < 0) return fail('STALE_CONTEXT', '修改记录所属活动已变化，请刷新')
      const activity = data.activity
        ? { ...data.activity, changes: data.activity.changes.slice(changeStart, changeStart + 20) }
        : null
      return clone({
        roomId,
        roomRevision: room.revision + data.sequence,
        activity,
        results: data.results.slice(resultStart, resultStart + 20),
        totals,
        nextResultCursor: data.results[resultStart + 20]?.activityId ?? null,
        nextChangeCursor: data.activity?.changes[changeStart + 20]?.requestId ?? null,
      })
    },
    async execute(roomId, command, requestId) {
      const { me, room } = await context(roomId)
      const data = read()
      const signature = JSON.stringify([roomId, me.userId, command])
      if (!requestId) return fail('INVALID_ARGUMENT', '缺少请求标识')
      if (data.receipts[requestId]) {
        const prior = data.receipts[requestId]!
        if ((typeof prior === 'string' ? prior : prior.signature) !== signature)
          return fail('IDEMPOTENCY_MISMATCH', '请求标识已用于其他操作')
        return typeof prior === 'string' ? undefined : clone(prior.receipt)
      }
      if (failure) {
        failure = false
        return fail('INTERNAL_ERROR', '本次操作未保存，请重试')
      }
      const saved = data.rooms[roomId] ?? { sequence: 0, activity: null, results: [] }
      if (command.kind === 'prepare') {
        if (command.expectedRoomRevision !== room.revision + saved.sequence)
          return fail('STALE_CONTEXT', '房间状态已变化，请重新确认名单')
        if (saved.activity?.status === 'open')
          return fail('CONFLICT', '已有进行中的打分，不能重新开始')
        const ids = command.participantIds
        if (
          (ids.length !== 2 && ids.length !== 3) ||
          new Set(ids).size !== ids.length ||
          !ids.includes(me.userId) ||
          ids.some((id) => !room.members.some((m) => m.userId === id))
        )
          return fail('INVALID_ARGUMENT', '请选择包括本人在内的2～3名不同房间成员')
        saved.sequence++
        saved.activity = {
          activityId: `${roomId}-point-${saved.sequence}`,
          revision: 0,
          status: 'open',
          participants: ids.map((id) => {
            const m = room.members.find((m) => m.userId === id)!
            return { userId: id, displayName: m.displayName }
          }),
          cards: Array.from({ length: 15 }, (_, i) => ({
            number: i + 1,
            ownerUserId: null,
            revision: 0,
            initialRecordedBy: null,
            lastModifiedBy: null,
          })),
          earnedPoints: Object.fromEntries(ids.map((id) => [id, 0])),
          changes: [],
          result: null,
        }
      } else {
        const activity = saved.activity
        if (!activity || activity.activityId !== command.activityId)
          return fail('STALE_CONTEXT', '本场已经变化，请刷新后操作')
        if (activity.status === 'posted')
          return fail('ALREADY_POSTED', '本次结果已保存，号码牌只读')
        const participating = activity.participants.some((p) => p.userId === me.userId)
        if (command.kind === 'post') {
          if (!participating) return fail('FORBIDDEN', '只有本场参与者可以保存结果')
          if (command.expectedActivityRevision !== activity.revision)
            return fail('CONFLICT', '号码牌有变化，请重新核对结果')
          if (
            activity.cards.length !== 15 ||
            activity.cards.some(
              (c) =>
                !c.ownerUserId || !activity.participants.some((p) => p.userId === c.ownerUserId),
            )
          )
            return fail('INVALID_ARGUMENT', '还有号码牌未记录，暂不能保存完整结果')
          const points = earned(activity)
          if (Object.values(points).reduce((sum, n) => sum + n, 0) !== 120)
            return fail('INVALID_RESPONSE', '进球总分异常，请刷新检查')
          const result: PointResult = {
            activityId: activity.activityId,
            participants: clone(activity.participants),
            earnedPoints: points,
            deltas: Object.fromEntries(
              Object.entries(points).map(([id, n]) => [id, n - 120 / activity.participants.length]),
            ),
            savedAt: Date.now(),
          }
          activity.result = result
          activity.status = 'posted'
          activity.revision++
          saved.results.unshift(clone(result))
        } else {
          const card = activity.cards.find((c) => c.number === command.number)
          if (!card || !Number.isInteger(command.number))
            return fail('INVALID_ARGUMENT', '请选择1—15号球')
          if (card.revision !== command.expectedCardRevision) {
            const name = activity.participants.find(
              (p) => p.userId === card.ownerUserId,
            )?.displayName
            return fail(
              'CONFLICT',
              name
                ? `${card.number}号已由${name}记录，请查看最新归属`
                : `${card.number}号状态已变化，请查看最新状态`,
            )
          }
          let owner: string | null
          if (command.kind === 'claim') {
            if (!participating) return fail('FORBIDDEN', '你未参加本场，不能认领号码牌')
            if (card.ownerUserId !== null) return fail('CONFLICT', '这张牌已被记录，请查看最新归属')
            owner = me.userId
          } else {
            if (card.ownerUserId === null) return fail('CONFLICT', '这张牌已退回公共区，请重新操作')
            owner = command.ownerUserId
            if (owner !== null && !activity.participants.some((p) => p.userId === owner))
              return fail('INVALID_ARGUMENT', '只能改给本场参与者')
            if (owner === card.ownerUserId)
              return fail('INVALID_ARGUMENT', '请选择其他参与者或退回公共区')
          }
          const change: PointChange = {
            requestId,
            number: card.number,
            fromUserId: card.ownerUserId,
            toUserId: owner,
            actorUserId: me.userId,
            actorName: me.displayName,
            createdAt: Date.now(),
          }
          card.ownerUserId = owner
          card.revision++
          card.lastModifiedBy = me.userId
          if (card.initialRecordedBy === null && command.kind === 'claim')
            card.initialRecordedBy = me.userId
          activity.changes.unshift(change)
          activity.earnedPoints = earned(activity)
          activity.revision++
        }
      }
      data.rooms[roomId] = saved
      const activity = saved.activity!
      const receipt: CommandReceipt = {
        requestId,
        entityId: activity.activityId,
        roomId,
        roomRevision: room.revision + saved.sequence,
        activityId: activity.activityId,
        activityRevision: activity.revision,
        ...(command.kind === 'claim' || command.kind === 'correct'
          ? {
              pointState: {
                activityId: activity.activityId,
                revision: activity.revision,
                status: 'open' as const,
                cards: clone(activity.cards),
                earnedPoints: clone(activity.earnedPoints),
                change: clone(activity.changes[0]!),
              },
            }
          : {}),
      }
      data.receipts[requestId] = { signature, receipt }
      storage.write(clone(data))
      if (lost) {
        lost = false
        return fail('TRANSPORT_UNKNOWN', '保存结果待确认，请确认原操作')
      }
      return clone(receipt)
    },
  }
}
