import { DA_A_BASE_STAKES, daADeltaUnits } from '@scoreboard/shared'
import type { DaABaseStake, DaARequest, DaASnapshot, DaAEntry } from '@scoreboard/shared'
import type { Activity, Room, User } from '../domain/models'
import type { Store } from '../repositories/store'
import { activeUser, requireMember } from './access'
import { executeCommand } from './commands'
import { publicUser } from './identity'
import { recordChange } from './notifications'
import { meta, stableId } from '../infrastructure/ids'
import { AppError } from '../infrastructure/errors'

export const DA_A_RULES_VERSION = 'da-a-personal-v1'
const totalsId = (roomId: string) => stableId('da_a_totals', roomId)
function configuredBase(room: Room): DaABaseStake {
  if (room.selectedMode !== 'da_a') throw new AppError('STALE_CONTEXT', '房间玩法已改变')
  if (!DA_A_BASE_STAKES.some((n) => n === room.daABaseStake))
    throw new AppError('RULE_NOT_CONFIGURED', '请使用已配置预设底分的打大A房间')
  return room.daABaseStake!
}
function validateActivity(room: Room, activity: Activity | null): asserts activity is Activity {
  const base = configuredBase(room)
  if (
    !activity ||
    activity.roomId !== room._id ||
    activity.mode !== 'da_a' ||
    activity.config.mode !== 'da_a' ||
    activity.rulesVersion !== DA_A_RULES_VERSION
  )
    throw new AppError('RULE_NOT_CONFIGURED', '该旧活动不支持个人记分')
  if (
    activity.scoreScale !== 100 ||
    activity.config.baseStakeUnits !== base * 100 ||
    activity.config.nonZeroSumPolicy !== 'personal' ||
    activity.participantIds.length !== 5 ||
    new Set(activity.participantIds).size !== 5 ||
    activity.participants.length !== 5 ||
    new Set(activity.participants.map((p) => p.userId)).size !== 5 ||
    activity.participants.some((p) => !activity.participantIds.includes(p.userId))
  )
    throw new AppError('INTERNAL_ERROR', '活动资料不完整')
}
function validateTotals(totals: Record<string, number>) {
  if (Object.values(totals).some((n) => !Number.isSafeInteger(n)))
    throw new AppError('INTERNAL_ERROR', '累计资料不完整')
}
function validateEntry(entry: DaAEntry) {
  try {
    if (
      entry.deltaUnits !==
        daADeltaUnits(entry.baseStake, entry.direction, entry.value, entry.mingA) ||
      !Number.isSafeInteger(entry.savedAt)
    )
      throw new Error('invalid entry')
  } catch {
    throw new AppError('INTERNAL_ERROR', '历史记分资料不完整')
  }
}

export function createDaAService(store: Store) {
  async function getState(
    query: Extract<DaARequest, { action: 'daA.getState' }>['payload'],
    actor: User,
    now: number,
  ): Promise<DaASnapshot> {
    return store.transaction(async (tx) => {
      const { room } = await requireMember(tx, query.roomId, actor._id, now)
      const baseStake = configuredBase(room)
      const aggregate = await tx.get('da_a_totals', totalsId(room._id))
      if (aggregate && aggregate.roomId !== room._id)
        throw new AppError('INTERNAL_ERROR', '累计房间不匹配')
      const totalsUnits = aggregate?.totalsUnits ?? {}
      validateTotals(totalsUnits)
      const state: DaASnapshot = {
        roomId: room._id,
        roomRevision: room.revision,
        baseStake,
        scoreScale: 100,
        activity: null,
        canRecord: false,
        entries: [],
        nextCursor: null,
        totalsUnits,
      }
      let cursor = query.cursor ?? aggregate?.latestEntryId ?? null
      for (let i = 0; cursor && i < 20; i++) {
        const record = await tx.get('da_a_entries', cursor)
        if (
          !record ||
          record.roomId !== room._id ||
          record.entry.roomId !== room._id ||
          record.entry.entryId !== record._id
        )
          throw new AppError(query.cursor ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR', '历史游标无效')
        validateEntry(record.entry)
        state.entries.push(record.entry)
        cursor = record.previousId
      }
      state.nextCursor = cursor
      if (room.activeActivityId) {
        const activity = await tx.get('activities', room.activeActivityId)
        validateActivity(room, activity)
        state.activity = {
          activityId: activity._id,
          revision: activity.revision,
          configRevision: activity.configRevision,
          status: activity.status,
          participants: activity.participants,
        }
        state.canRecord = activity.status === 'open' && activity.participantIds.includes(actor._id)
      }
      return state
    })
  }

  async function command(
    request: Extract<DaARequest, { action: 'daA.prepare' | 'daA.addDelta' }>,
    actor: User,
    now: number,
  ) {
    const p = request.payload
    return executeCommand(
      store,
      actor._id,
      request,
      now,
      async (tx) => {
        await activeUser(tx, actor._id)
        const room = await tx.get('rooms', p.roomId)
        if (room && room.wechatAppId !== actor.wechatAppId)
          throw new AppError('FORBIDDEN', '无法访问其他小程序房间')
      },
      async (tx) => {
        const { room } = await requireMember(tx, p.roomId, actor._id, now)
        const baseStake = configuredBase(room)
        if (request.action === 'daA.prepare') {
          const input = request.payload
          if (room.revision !== input.expectedRoomRevision)
            throw new AppError('STALE_CONTEXT', '房间已更新，请刷新')
          if (!input.participantIds.includes(actor._id))
            throw new AppError('FORBIDDEN', '名单必须包含本人')
          if (room.activeActivityId) {
            const previous = await tx.get('activities', room.activeActivityId)
            if (!previous) throw new AppError('INTERNAL_ERROR', '活动资料不完整')
            if (previous.status === 'open') throw new AppError('CONFLICT', '当前活动仍在进行中')
          }
          const participants: Activity['participants'] = []
          for (const userId of input.participantIds) {
            await requireMember(tx, room._id, userId, now)
            const profile = publicUser(await activeUser(tx, userId))
            participants.push({
              userId,
              displayName: profile.displayName,
              avatarFileId: profile.avatarFileId,
              ...(profile.defaultAvatar ? { defaultAvatar: profile.defaultAvatar } : {}),
            })
          }
          const id = stableId('da_a_activity', actor._id, request.requestId)
          const activity: Activity = {
            ...meta(id, now),
            roomId: room._id,
            mode: 'da_a',
            createdBy: actor._id,
            status: 'open',
            participantIds: input.participantIds,
            participants,
            rulesVersion: DA_A_RULES_VERSION,
            configRevision: 0,
            scoreScale: 100,
            config: {
              mode: 'da_a',
              baseStakeUnits: baseStake * 100,
              coefficientScale: 1,
              nonZeroSumPolicy: 'personal',
            },
            completedResultEventId: null,
            currentResultToken: null,
          }
          await tx.set('activities', activity)
          for (const userId of input.participantIds)
            await tx.set('activity_scores', {
              ...meta(stableId('score', id, userId), now),
              roomId: room._id,
              activityId: id,
              mode: 'da_a',
              userId,
              scoreScale: 100,
              netUnits: 0,
              earnedPoints: null,
              ownedCardCount: null,
              remainingCount: null,
            })
          await tx.set('rooms', {
            ...room,
            activeActivityId: id,
            revision: room.revision + 1,
            updatedAt: now,
          })
          await recordChange(tx, request.requestId, actor._id, room._id, now, id)
          return {
            requestId: request.requestId,
            entityId: id,
            roomId: room._id,
            roomRevision: room.revision + 1,
            activityId: id,
            activityRevision: 0,
          }
        }
        const input = request.payload
        if (room.activeActivityId !== input.activityId)
          throw new AppError('STALE_CONTEXT', '活动已改变，请刷新')
        const activity = await tx.get('activities', input.activityId)
        validateActivity(room, activity)
        if (activity.status !== 'open' || activity.configRevision !== input.expectedConfigRevision)
          throw new AppError('STALE_CONTEXT', '活动或配置已改变')
        if (!activity.participantIds.includes(actor._id))
          throw new AppError('FORBIDDEN', '只有本场参与者可以记分')
        const deltaUnits = daADeltaUnits(baseStake, input.direction, input.value, input.mingA)
        const aggregateId = totalsId(room._id)
        const aggregate = await tx.get('da_a_totals', aggregateId)
        if (aggregate && aggregate.roomId !== room._id)
          throw new AppError('INTERNAL_ERROR', '累计房间不匹配')
        const totalsUnits = { ...aggregate?.totalsUnits }
        validateTotals(totalsUnits)
        const score = await tx.get('activity_scores', stableId('score', activity._id, actor._id))
        if (
          !score ||
          score.roomId !== room._id ||
          score.activityId !== activity._id ||
          score.userId !== actor._id ||
          score.mode !== 'da_a' ||
          score.scoreScale !== 100 ||
          !Number.isSafeInteger(score.netUnits)
        )
          throw new AppError('INTERNAL_ERROR', '个人成绩资料不完整')
        const netUnits = score.netUnits + deltaUnits
        totalsUnits[actor._id] = (totalsUnits[actor._id] ?? 0) + deltaUnits
        if (!Number.isSafeInteger(netUnits) || !Number.isSafeInteger(totalsUnits[actor._id]))
          throw new AppError('CONFLICT', '累计分数超出范围')
        const entryId = stableId('da_a_entry', actor._id, request.requestId)
        const participant = activity.participants.find((p) => p.userId === actor._id)!
        const entry: DaAEntry = {
          entryId,
          requestId: request.requestId,
          roomId: room._id,
          activityId: activity._id,
          userId: actor._id,
          displayName: participant.displayName,
          direction: input.direction,
          value: input.value,
          baseStake,
          mingA: input.mingA,
          deltaUnits,
          savedAt: now,
        }
        await tx.set('da_a_entries', {
          ...meta(entryId, now),
          roomId: room._id,
          previousId: aggregate?.latestEntryId ?? null,
          entry,
        })
        await tx.set('da_a_totals', {
          ...(aggregate ?? meta(aggregateId, now)),
          roomId: room._id,
          totalsUnits,
          latestEntryId: entryId,
          updatedAt: now,
          revision: (aggregate?.revision ?? -1) + 1,
        })
        await tx.set('activity_scores', {
          ...score,
          netUnits,
          revision: score.revision + 1,
          updatedAt: now,
        })
        await tx.set('activities', { ...activity, revision: activity.revision + 1, updatedAt: now })
        await recordChange(tx, request.requestId, actor._id, room._id, now, activity._id)
        return {
          requestId: request.requestId,
          entityId: entryId,
          roomId: room._id,
          activityId: activity._id,
          activityRevision: activity.revision + 1,
        }
      },
    )
  }
  return { getState, command }
}
