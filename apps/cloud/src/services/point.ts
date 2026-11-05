import type {
  CommandRequest,
  FoundationRequest,
  PointResult,
  PointCommitState,
  PointCardDTO,
  PointChange,
  PointSnapshot,
} from '@scoreboard/shared'
import type { Activity, PointCard, Room, User } from '../domain/models'
import type { Store, Transaction } from '../repositories/store'
import { AppError } from '../infrastructure/errors'
import { meta, stableId } from '../infrastructure/ids'
import { requireMember } from './access'
import { executeCommand } from './commands'
import { recordChange } from './notifications'
import { pointBaseline, validatePointResult } from './point-rules'
import { readPointCards } from './point-cards'

type PointCommand = Extract<
  CommandRequest,
  { action: 'point.claim' | 'point.correct' | 'point.post' }
>
type StateQuery = Extract<FoundationRequest, { action: 'point.getState' }>['payload']
const resultId = (activityId: string) => stableId('point_result', activityId)
const totalsId = (roomId: string) => stableId('point_totals', roomId)
const participants = (activity: Activity) =>
  activity.participants.map(({ userId, displayName }) => ({ userId, displayName }))
const cardDTO = (card: PointCard): PointCardDTO => ({
  number: card.number,
  ownerUserId: card.ownerUserId,
  revision: card.revision,
  initialRecordedBy: card.initialRecordedBy ?? null,
  lastModifiedBy: card.updatedBy,
})
function requirePoint(room: Room, activity: Activity | null): asserts activity is Activity {
  if (room.selectedMode !== 'point_ball')
    throw new AppError('STALE_CONTEXT', '房间玩法已改变，请刷新')
  if (
    !activity ||
    activity.roomId !== room._id ||
    activity.mode !== 'point_ball' ||
    activity.config.mode !== 'point_ball' ||
    ![2, 3].includes(activity.participantIds.length) ||
    new Set(activity.participantIds).size !== activity.participantIds.length ||
    activity.participants.length !== activity.participantIds.length ||
    activity.participants.some((p) => !activity.participantIds.includes(p.userId)) ||
    new Set(activity.participants.map((p) => p.userId)).size !== activity.participantIds.length ||
    activity.config.totalPoints !== 120 ||
    activity.config.baselineUnits !== pointBaseline(activity.participantIds.length)
  )
    throw new AppError('INTERNAL_ERROR', '打分活动资料不完整')
}
async function cardsAndPoints(tx: Transaction, activity: Activity) {
  const cards = await readPointCards(tx, activity)
  const earnedPoints: Record<string, number> = Object.fromEntries(
    activity.participantIds.map((id) => [id, 0]),
  )
  for (const card of cards) {
    if (card.ownerUserId !== null) earnedPoints[card.ownerUserId] += card.points
  }
  return { cards, earnedPoints }
}

export function createPointService(store: Store) {
  async function getState(query: StateQuery, actor: User, now: number): Promise<PointSnapshot> {
    return store.transaction(async (tx) => {
      const { room } = await requireMember(tx, query.roomId, actor._id, now)
      if (room.selectedMode !== 'point_ball')
        throw new AppError('STALE_CONTEXT', '房间玩法已改变，请刷新')
      const aggregate = await tx.get('point_totals', totalsId(room._id))
      const state: PointSnapshot = {
        roomId: room._id,
        roomRevision: room.revision,
        activity: null,
        results: [],
        totals: aggregate?.totals ?? {},
        nextResultCursor: null,
        nextChangeCursor: null,
      }
      let cursor = query.resultCursor ?? aggregate?.latestResultId ?? null
      for (let count = 0; cursor && count < 20; count++) {
        const record = await tx.get('point_results', cursor)
        if (!record || record.roomId !== room._id)
          throw new AppError(
            query.resultCursor ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR',
            '结果记录或游标无效',
          )
        validatePointResult(record.result)
        state.results.push(record.result)
        cursor = record.previousId
      }
      state.nextResultCursor = cursor
      if (!room.activeActivityId) {
        if (query.changeCursor) throw new AppError('STALE_CONTEXT', '当前没有打分活动')
        return state
      }
      const activity = await tx.get('activities', room.activeActivityId)
      requirePoint(room, activity)
      if (activity.status === 'archived') throw new AppError('STALE_CONTEXT', '当前活动已归档')
      const { cards, earnedPoints } = await cardsAndPoints(tx, activity)
      const posted = await tx.get('point_results', resultId(activity._id))
      if ((activity.status === 'posted') !== !!posted)
        throw new AppError('INTERNAL_ERROR', '活动结果资料不完整')
      if (posted) validatePointResult(posted.result)
      state.activity = {
        activityId: activity._id,
        revision: activity.revision,
        status: activity.status,
        participants: participants(activity),
        cards: cards.map(cardDTO),
        earnedPoints,
        changes: [],
        result: posted?.result ?? null,
      }
      cursor = query.changeCursor ?? activity.latestPointChangeId ?? null
      for (let count = 0; cursor && count < 20; count++) {
        const record = await tx.get('point_changes', cursor)
        if (!record || record.roomId !== room._id || record.activityId !== activity._id)
          throw new AppError(
            query.changeCursor ? 'STALE_CONTEXT' : 'INTERNAL_ERROR',
            '修改记录已不属于当前活动，请刷新',
          )
        state.activity.changes.push(record.change)
        cursor = record.previousId
      }
      state.nextChangeCursor = cursor
      return state
    })
  }

  async function command(request: PointCommand, actor: User, now: number) {
    const p = request.payload
    return executeCommand(
      store,
      actor._id,
      request,
      now,
      async (tx) => {
        await requireMember(tx, p.roomId, actor._id, now)
      },
      async (tx) => {
        const { room } = await requireMember(tx, p.roomId, actor._id, now)
        if (room.activeActivityId !== p.activityId)
          throw new AppError('STALE_CONTEXT', '活动已改变，请刷新')
        const activity = await tx.get('activities', p.activityId)
        requirePoint(room, activity)
        if (activity.status === 'posted') throw new AppError('ALREADY_POSTED', '本次结果已保存')
        if (activity.status !== 'open') throw new AppError('STALE_CONTEXT', '活动已关闭')
        if (request.action !== 'point.correct' && !activity.participantIds.includes(actor._id))
          throw new AppError('FORBIDDEN', '只有本场参与者可以认领或保存')
        const { cards, earnedPoints } = await cardsAndPoints(tx, activity)
        let pointState: PointCommitState | undefined
        if (request.action === 'point.post') {
          if (activity.revision !== request.payload.expectedActivityRevision)
            throw new AppError('STALE_CONTEXT', '牌面已更新，请重新确认')
          if (
            cards.some((card) => card.ownerUserId === null) ||
            Object.values(earnedPoints).reduce((sum, n) => sum + n, 0) !== 120
          )
            throw new AppError('CONFLICT', '请先记录完整的15张牌')
          const id = resultId(activity._id)
          if (await tx.get('point_results', id))
            throw new AppError('ALREADY_POSTED', '本次结果已保存')
          const aggregateId = totalsId(room._id)
          const aggregate = await tx.get('point_totals', aggregateId)
          const totals = { ...aggregate?.totals }
          const baseline = pointBaseline(activity.participantIds.length)
          const deltas = Object.fromEntries(
            activity.participantIds.map((userId) => [userId, earnedPoints[userId] - baseline]),
          )
          for (const userId of activity.participantIds) {
            totals[userId] = (totals[userId] ?? 0) + deltas[userId]
            if (!Number.isSafeInteger(totals[userId]))
              throw new AppError('CONFLICT', '累计分数超出范围')
            const score = await tx.get('activity_scores', stableId('score', activity._id, userId))
            if (!score) throw new AppError('INTERNAL_ERROR', '成绩资料不完整')
            await tx.set('activity_scores', {
              ...score,
              earnedPoints: earnedPoints[userId],
              netUnits: deltas[userId],
              revision: score.revision + 1,
              updatedAt: now,
            })
          }
          const result: PointResult = {
            activityId: activity._id,
            participants: participants(activity),
            earnedPoints,
            deltas,
            savedAt: now,
          }
          await tx.set('point_results', {
            ...meta(id, now),
            roomId: room._id,
            previousId: aggregate?.latestResultId ?? null,
            result,
          })
          await tx.set('point_totals', {
            ...(aggregate ?? meta(aggregateId, now)),
            roomId: room._id,
            latestResultId: id,
            totals,
            updatedAt: now,
            revision: (aggregate?.revision ?? -1) + 1,
          })
          await tx.set('activities', {
            ...activity,
            status: 'posted',
            completedResultEventId: id,
            revision: activity.revision + 1,
            updatedAt: now,
          })
        } else {
          const input = request.payload
          const card = cards[input.number - 1]
          if (card.revision !== input.expectedCardRevision)
            throw new AppError('CONFLICT', '该号码归属已改变，请刷新')
          let owner: string | null
          if (request.action === 'point.claim') {
            if (card.ownerUserId !== null) throw new AppError('CONFLICT', '该号码已被记录')
            owner = actor._id
          } else {
            if (card.ownerUserId === null) throw new AppError('CONFLICT', '未记录号码请使用认领')
            owner = request.payload.ownerUserId
            if (owner !== null && !activity.participantIds.includes(owner))
              throw new AppError('INVALID_ARGUMENT', '目标必须是本场参与者')
            if (owner === card.ownerUserId) throw new AppError('CONFLICT', '归属没有改变')
          }
          if (card.ownerUserId !== null) earnedPoints[card.ownerUserId] -= card.number
          if (owner !== null) earnedPoints[owner] += card.number
          const updatedCard: PointCard = {
            ...card,
            ownerUserId: owner,
            updatedBy: actor._id,
            initialRecordedBy: card.initialRecordedBy ?? actor._id,
            revision: card.revision + 1,
            updatedAt: now,
          }
          await tx.set('activity_cards', updatedCard)
          for (const userId of new Set([card.ownerUserId, owner])) {
            if (userId === null) continue
            const score = await tx.get('activity_scores', stableId('score', activity._id, userId))
            if (!score) throw new AppError('INTERNAL_ERROR', '成绩资料不完整')
            await tx.set('activity_scores', {
              ...score,
              earnedPoints: earnedPoints[userId],
              ownedCardCount: cards.filter((c) =>
                c.number === card.number ? owner === userId : c.ownerUserId === userId,
              ).length,
              revision: score.revision + 1,
              updatedAt: now,
            })
          }
          const changeId = stableId('point_change', actor._id, request.requestId)
          const change: PointChange = {
            requestId: request.requestId,
            number: card.number,
            fromUserId: card.ownerUserId,
            toUserId: owner,
            actorUserId: actor._id,
            actorName: actor.displayName,
            createdAt: now,
          }
          await tx.set('point_changes', {
            ...meta(changeId, now),
            roomId: room._id,
            activityId: activity._id,
            previousId: activity.latestPointChangeId ?? null,
            change,
          })
          pointState = {
            activityId: activity._id,
            revision: activity.revision + 1,
            status: 'open',
            cards: cards.map((current) =>
              cardDTO(current.number === card.number ? updatedCard : current),
            ),
            earnedPoints,
            change,
          }
          await tx.set('activities', {
            ...activity,
            latestPointChangeId: changeId,
            revision: activity.revision + 1,
            updatedAt: now,
          })
        }
        await recordChange(tx, request.requestId, actor._id, room._id, now, activity._id)
        return {
          requestId: request.requestId,
          entityId: activity._id,
          roomId: room._id,
          roomRevision: room.revision,
          activityId: activity._id,
          activityRevision: activity.revision + 1,
          ...(pointState ? { pointState } : {}),
        }
      },
    )
  }
  return { getState, command }
}
