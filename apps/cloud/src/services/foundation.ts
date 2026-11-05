import type {
  CommandReceipt,
  CommandRequest,
  FoundationRequest,
  FoundationResponse,
  MemberPage,
  FoundationRoomPreview,
  FoundationRoomSnapshot,
} from '@scoreboard/shared'
import type { Caller, Room, Rules, User } from '../domain/models'
import type { Store, Transaction } from '../repositories/store'
import { AppError } from '../infrastructure/errors'
import { canonicalHash, meta, newId, newJoinCode, stableId } from '../infrastructure/ids'
import { activeUser, requireMember, roomFromCode } from './access'
import { checkRateLimit, executeCommand } from './commands'
import { publicUser, resolveCaller } from './identity'
import { recordChange } from './notifications'
import { defaultRules, prepareConfig } from './rules'
import { createPointService } from './point'
import { POINT_RULES_VERSION } from './point-rules'
import { validateAvatarReference } from './avatar'
import { listRecentRoomPage } from './recent-rooms'
import { createDaAService } from './da-a'
import { readPointCards } from './point-cards'

interface Dependencies {
  store: Store
  now?: () => number
  id?: (kind: string) => string
  joinCode?: () => string
  rules?: Rules
  avatarEnvironmentId?: string
  avatarReferenceValidator?: (fileId: string, userId: string) => void
  validateAvatar?: (fileId: string) => Promise<void>
}
const preview = (room: Room): FoundationRoomPreview => ({
  roomId: room._id,
  displayName: room.displayName,
  selectedMode: room.selectedMode,
  memberCount: room.memberCount,
  name: room.displayName,
  joinCode: room.activeCodeId,
  status: room.status,
})

export function createFoundation(deps: Dependencies) {
  const { store } = deps
  const clock = deps.now ?? Date.now
  const makeId = deps.id ?? newId
  const makeCode = deps.joinCode ?? newJoinCode
  const rules = deps.rules ?? defaultRules
  const point = createPointService(store)
  const daA = createDaAService(store)

  async function dispatch(request: FoundationRequest, caller: Caller): Promise<FoundationResponse> {
    const now = clock()
    const actor = await resolveCaller(store, caller, now)
    if (request.action === 'daA.getState') return daA.getState(request.payload, actor, now)
    if (request.action === 'daA.prepare' || request.action === 'daA.addDelta')
      return daA.command(request, actor, now)
    if (request.action === 'point.getState') return point.getState(request.payload, actor, now)
    if (
      request.action === 'point.claim' ||
      request.action === 'point.correct' ||
      request.action === 'point.post'
    )
      return point.command(request, actor, now)
    if (request.action === 'identity.getMe') return publicUser(actor)
    if (request.action === 'room.preview') {
      await checkRateLimit(store, actor._id, now, 'code_lookup', 30)
      return store.transaction(async (tx) =>
        preview(await roomFromCode(tx, request.payload.joinCode, now, actor.wechatAppId)),
      )
    }
    if (request.action === 'room.listRecent') {
      const rooms: FoundationRoomPreview[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await listRecentRoomPage(
          store,
          actor,
          now,
          { cursor, limit: 20 - rooms.length },
          preview,
        )
        for (const room of page.rooms)
          if (!seen.has(room.roomId)) {
            seen.add(room.roomId)
            rooms.push({ ...room, displayName: room.name })
          }
        cursor = page.nextCursor ?? undefined
      } while (cursor && rooms.length < 20)
      return rooms
    }
    if (request.action === 'room.listRecentPage')
      return listRecentRoomPage(store, actor, now, request.payload, preview)
    if (request.action === 'room.getSnapshot')
      return getSnapshot(request.payload.roomId, actor, now)
    if (request.action === 'room.listMembers') {
      return store.transaction(async (tx) => {
        await requireMember(tx, request.payload.roomId, actor._id, now)
        const list = await tx.listMembers(
          request.payload.roomId,
          request.payload.cursor,
          request.payload.limit + 1,
        )
        const page = list.slice(0, request.payload.limit)
        const members = []
        for (const member of page) {
          const user = await tx.get('users', member.userId)
          if (!user) throw new AppError('INTERNAL_ERROR', '成员资料不可用')
          members.push({ ...publicUser(user), joinedAt: new Date(member.joinedAt).toISOString() })
        }
        return {
          members,
          nextCursor: list.length > page.length ? page.at(-1)!._id : null,
        } satisfies MemberPage
      })
    }
    return command(request, actor, now)
  }

  async function command(
    request: Exclude<
      CommandRequest,
      { action: 'point.claim' | 'point.correct' | 'point.post' | 'daA.prepare' | 'daA.addDelta' }
    >,
    actor: User,
    now: number,
  ): Promise<CommandReceipt> {
    let avatarValidation: Promise<void> | undefined
    // Values generated once per invocation stay stable during database transaction retries.
    const creating = request.action === 'room.create' || request.action === 'daA.createRoom'
    const entityId = makeId(creating ? 'room' : 'activity')
    const slotId = makeId('result')
    const candidates = creating ? Array.from({ length: 10 }, makeCode) : []
    const rateKey = canonicalHash(request)
    if (creating) await checkRateLimit(store, actor._id, now, 'create', 10, rateKey)
    if (request.action === 'room.join')
      await checkRateLimit(store, actor._id, now, 'code_lookup', 30, rateKey)
    if (request.action === 'identity.updateProfile')
      await checkRateLimit(store, actor._id, now, 'profile_update', 10, rateKey)
    return executeCommand(
      store,
      actor._id,
      request,
      now,
      async (tx) => {
        await activeUser(tx, actor._id)
        // Recent/join receipts belong to this authenticated actor. Recover them before checking
        // current room liveness; a late retry must not repeat an enter after a later dismiss.
        if (
          'roomId' in request.payload &&
          request.action !== 'room.dismissRecent' &&
          request.action !== 'room.enter'
        )
          await requireMember(tx, request.payload.roomId, actor._id, now)
      },
      async (tx) => {
        switch (request.action) {
          case 'room.enter':
          case 'room.dismissRecent': {
            const id = stableId('mem', request.payload.roomId, actor._id)
            const member = await tx.get('room_members', id)
            if (!member || member.userId !== actor._id || member.roomId !== request.payload.roomId)
              throw new AppError('FORBIDDEN', '请先加入房间')
            const hiding = request.action === 'room.dismissRecent'
            const room = await tx.get('rooms', request.payload.roomId)
            if (room && room.wechatAppId !== actor.wechatAppId)
              throw new AppError('FORBIDDEN', '无法访问其他小程序的房间')
            if (!hiding) await requireMember(tx, request.payload.roomId, actor._id, now)
            if (!hiding || member.recentHidden !== true)
              await tx.set('room_members', {
                ...member,
                recentHidden: hiding,
                lastVisitedAt: hiding ? member.lastVisitedAt : now,
                updatedAt: now,
                revision: member.revision + 1,
              })
            return {
              requestId: request.requestId,
              entityId: request.payload.roomId,
              roomId: request.payload.roomId,
              ...(room ? { roomRevision: room.revision } : {}),
            }
          }
          case 'identity.updateProfile': {
            const user = await activeUser(tx, actor._id)
            const avatarFileId =
              request.payload.avatarFileId === undefined
                ? user.avatarFileId
                : request.payload.avatarFileId
            if (request.payload.avatarFileId) {
              if (deps.avatarReferenceValidator)
                deps.avatarReferenceValidator(request.payload.avatarFileId, actor._id)
              else
                validateAvatarReference(
                  request.payload.avatarFileId,
                  actor._id,
                  deps.avatarEnvironmentId,
                )
              if (!deps.validateAvatar) throw new AppError('INTERNAL_ERROR', '头像校验尚未配置')
              avatarValidation ??= deps.validateAvatar(request.payload.avatarFileId)
              await avatarValidation
            }
            await tx.set('users', {
              ...user,
              displayName: request.payload.displayName,
              avatarFileId,
              profileCompletedAt: user.profileCompletedAt ?? now,
              updatedAt: now,
              revision: user.revision + 1,
            })
            return { requestId: request.requestId, entityId: actor._id }
          }
          case 'room.create':
          case 'daA.createRoom': {
            let code: string | undefined
            for (const candidate of candidates) {
              if (!(await tx.get('room_codes', candidate))) {
                code = candidate
                break
              }
            }
            if (!code) throw new AppError('CONFLICT', '房间码暂时不可用，请重试')
            const room: Room = {
              ...meta(entityId, now),
              displayName: '朋友记分房间',
              wechatAppId: actor.wechatAppId,
              selectedMode: request.action === 'daA.createRoom' ? 'da_a' : request.payload.mode,
              ...(request.action === 'daA.createRoom'
                ? { daABaseStake: request.payload.baseStake }
                : {}),
              activeActivityId: null,
              createdBy: actor._id,
              status: 'active',
              activeCodeId: code,
              memberCount: 1,
              expiresAt: null,
            }
            await tx.set('rooms', room)
            await tx.set('room_codes', {
              ...meta(code, now),
              roomId: entityId,
              status: 'active',
              expiresAt: null,
            })
            await createMembership(tx, room, actor, now, 'create')
            await recordChange(tx, request.requestId, actor._id, room._id, now)
            return {
              requestId: request.requestId,
              entityId,
              roomId: entityId,
              roomRevision: 0,
              joinCode: code,
            }
          }
          case 'room.join': {
            const room = await roomFromCode(tx, request.payload.joinCode, now, actor.wechatAppId)
            const id = stableId('mem', room._id, actor._id)
            const existing = await tx.get('room_members', id)
            if (existing?.status === 'active') {
              await tx.set('room_members', {
                ...existing,
                recentHidden: false,
                lastVisitedAt: now,
                updatedAt: now,
                revision: existing.revision + 1,
              })
              return {
                requestId: request.requestId,
                entityId: room._id,
                roomId: room._id,
                roomRevision: room.revision,
              }
            }
            await createMembership(tx, room, actor, now, 'code')
            await tx.set('rooms', {
              ...room,
              memberCount: room.memberCount + 1,
              revision: room.revision + 1,
              updatedAt: now,
            })
            await recordChange(tx, request.requestId, actor._id, room._id, now)
            return {
              requestId: request.requestId,
              entityId: room._id,
              roomId: room._id,
              roomRevision: room.revision + 1,
            }
          }
          case 'room.selectMode': {
            const { room } = await requireMember(tx, request.payload.roomId, actor._id, now)
            checkRoomRevision(room, request.payload.expectedRoomRevision)
            await ensurePreviousFinished(tx, room)
            if (room.selectedMode !== request.payload.mode) {
              await tx.set('rooms', {
                ...room,
                selectedMode: request.payload.mode,
                activeActivityId: null,
                revision: room.revision + 1,
                updatedAt: now,
              })
              await recordChange(tx, request.requestId, actor._id, room._id, now)
            }
            return {
              requestId: request.requestId,
              entityId: room._id,
              roomId: room._id,
              roomRevision: room.revision + (room.selectedMode === request.payload.mode ? 0 : 1),
            }
          }
          case 'activity.prepare': {
            const { room } = await requireMember(tx, request.payload.roomId, actor._id, now)
            if (room.selectedMode === 'da_a' && room.daABaseStake !== undefined)
              throw new AppError('RULE_NOT_CONFIGURED', '个人记分请使用daA.prepare')
            checkRoomRevision(room, request.payload.expectedRoomRevision)
            await ensurePreviousFinished(tx, room)
            const { participantIds, configInput } = request.payload
            if (!participantIds.includes(actor._id))
              throw new AppError('FORBIDDEN', '准备活动时必须包含本人')
            const participants = []
            for (const userId of participantIds) {
              await requireMember(tx, room._id, userId, now)
              participants.push(publicUser(await activeUser(tx, userId)))
            }
            const { config, scoreScale } = prepareConfig(
              room.selectedMode,
              participants.length,
              configInput,
              rules,
            )
            const poker = config.mode === 'da_a' || config.mode === 'dui_jia'
            await tx.set('activities', {
              ...meta(entityId, now),
              roomId: room._id,
              mode: room.selectedMode,
              createdBy: actor._id,
              status: 'open',
              participantIds,
              participants,
              rulesVersion: config.mode === 'point_ball' ? POINT_RULES_VERSION : rules.version,
              configRevision: 0,
              scoreScale,
              config,
              completedResultEventId: null,
              currentResultToken: poker ? slotId : null,
            })
            for (const userId of participantIds) {
              await tx.set('activity_scores', {
                ...meta(stableId('score', entityId, userId), now),
                roomId: room._id,
                activityId: entityId,
                mode: room.selectedMode,
                userId,
                scoreScale,
                netUnits: 0,
                earnedPoints: config.mode === 'point_ball' ? 0 : null,
                ownedCardCount: config.mode === 'point_ball' ? 0 : null,
                remainingCount: null,
              })
            }
            if (config.mode === 'point_ball') {
              for (const number of config.cardNumbers) {
                await tx.set('activity_cards', {
                  ...meta(stableId('card', entityId, String(number)), now),
                  roomId: room._id,
                  activityId: entityId,
                  mode: 'point_ball',
                  number,
                  points: number,
                  ownerUserId: null,
                  updatedBy: null,
                  initialRecordedBy: null,
                })
              }
            }
            if (poker) {
              await tx.set('result_slots', {
                ...meta(slotId, now),
                roomId: room._id,
                activityId: entityId,
                mode: config.mode,
                configRevision: 0,
                participantIds,
                participantsSnapshot: participants,
                status: 'open',
                postedEventId: null,
                previousResultToken: null,
              })
            }
            await tx.set('rooms', {
              ...room,
              activeActivityId: entityId,
              revision: room.revision + 1,
              updatedAt: now,
            })
            await recordChange(tx, request.requestId, actor._id, room._id, now, entityId)
            return {
              requestId: request.requestId,
              entityId,
              activityId: entityId,
              activityRevision: 0,
              roomId: room._id,
              roomRevision: room.revision + 1,
            }
          }
        }
      },
    )
  }

  async function createMembership(
    tx: Transaction,
    room: Room,
    actor: User,
    now: number,
    source: 'create' | 'code',
  ) {
    const memberId = stableId('mem', room._id, actor._id)
    const previous = await tx.get('room_members', memberId)
    await tx.set('room_members', {
      ...(previous ?? meta(memberId, now)),
      roomId: room._id,
      userId: actor._id,
      status: 'active',
      joinedAt: previous?.joinedAt ?? now,
      leftAt: null,
      joinSource: source,
      recentHidden: false,
      lastVisitedAt: now,
      updatedAt: now,
      revision: previous ? previous.revision + 1 : 0,
    })
    const signalId = stableId('signal', room._id, actor._id)
    const signal = await tx.get('user_room_signals', signalId)
    if (!signal)
      await tx.set('user_room_signals', {
        ...meta(signalId, now),
        _openid: actor.wechatOpenId,
        roomId: room._id,
        signalVersion: 0,
      })
  }

  function checkRoomRevision(room: Room, expected: number) {
    if (room.revision !== expected)
      throw new AppError('STALE_CONTEXT', '房间状态已更新，请刷新后重试')
  }
  async function ensurePreviousFinished(tx: Transaction, room: Room) {
    if (room.activeActivityId) {
      const activity = await tx.get('activities', room.activeActivityId)
      if (!activity) throw new AppError('INTERNAL_ERROR', '当前活动资料不完整')
      if (activity.status === 'open') throw new AppError('CONFLICT', '当前活动尚在进行中，不能覆盖')
    }
  }

  async function getSnapshot(
    roomId: string,
    actor: User,
    now: number,
  ): Promise<FoundationRoomSnapshot> {
    return store.transaction(async (tx) => {
      const { room } = await requireMember(tx, roomId, actor._id, now)
      const base: FoundationRoomSnapshot = {
        ...preview(room),
        roomRevision: room.revision,
        revision: room.revision,
        members: [],
        membersNextCursor: null,
        activeActivityId: room.activeActivityId,
        signalDocumentId: stableId('signal', roomId, actor._id),
        activity: null,
        scores: [],
        cards: [],
        isCurrentParticipant: false,
      }
      const members = await tx.listMembers(roomId, undefined, 21)
      for (const member of members.slice(0, 20)) {
        const user = await tx.get('users', member.userId)
        if (!user) throw new AppError('INTERNAL_ERROR', '成员资料不可用')
        base.members.push({
          ...publicUser(user),
          joinedAt: new Date(member.joinedAt).toISOString(),
        })
      }
      base.membersNextCursor = members.length > 20 ? members[19]._id : null
      if (!room.activeActivityId) return base
      const activity = await tx.get('activities', room.activeActivityId)
      if (!activity || activity.roomId !== roomId)
        throw new AppError('INTERNAL_ERROR', '当前活动资料不完整')
      base.activity = {
        activityId: activity._id,
        mode: activity.mode,
        status: activity.status,
        participantIds: activity.participantIds,
        participants: activity.participants,
        rulesVersion: activity.rulesVersion,
        revision: activity.revision,
        configRevision: activity.configRevision,
        scoreScale: activity.scoreScale,
        config: activity.config,
      }
      base.isCurrentParticipant = activity.participantIds.includes(actor._id)
      for (const userId of activity.participantIds) {
        const score = await tx.get('activity_scores', stableId('score', activity._id, userId))
        if (!score) throw new AppError('INTERNAL_ERROR', '活动成绩资料不完整')
        base.scores.push({
          userId,
          netUnits: score.netUnits,
          earnedPoints: score.earnedPoints,
          remainingCount: score.remainingCount,
        })
      }
      if (activity.mode === 'point_ball') {
        for (const card of await readPointCards(tx, activity)) {
          base.cards.push({
            number: card.number,
            ownerUserId: card.ownerUserId,
            revision: card.revision,
          })
        }
      }
      return base
    })
  }
  return { dispatch }
}
