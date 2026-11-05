import type { RecentRoomPage, RoomPreview } from '@scoreboard/shared'
import type { Room, User } from '../domain/models'
import type { RecentPosition, Store } from '../repositories/store'
import { AppError } from '../infrastructure/errors'
import { stableId } from '../infrastructure/ids'
import { activeUser } from './access'

const checksum = (actorId: string, p: RecentPosition) =>
  stableId('recent_cursor', actorId, String(p.lastVisitedAt), p.id).slice(-16)
function encode(actorId: string, p: RecentPosition): string {
  return `r1_${p.lastVisitedAt.toString(36)}_${p.id.slice(4)}_${checksum(actorId, p)}`
}
function decode(actorId: string, cursor: string | undefined): RecentPosition | undefined {
  if (!cursor) return undefined
  const m = /^r1_([0-9a-z]+)_([0-9a-f]{64})_([0-9a-f]{16})$/.exec(cursor)
  if (m) {
    const p = { lastVisitedAt: parseInt(m[1], 36), id: `mem_${m[2]}` }
    if (
      Number.isSafeInteger(p.lastVisitedAt) &&
      p.lastVisitedAt >= 0 &&
      p.lastVisitedAt.toString(36) === m[1] &&
      checksum(actorId, p) === m[3]
    )
      return p
  }
  throw new AppError('INVALID_ARGUMENT', '最近房间游标无效，请重新加载')
}

export async function listRecentRoomPage(
  store: Store,
  actor: User,
  now: number,
  input: { cursor?: string; limit: number },
  preview: (room: Room) => RoomPreview,
): Promise<RecentRoomPage> {
  const start = decode(actor._id, input.cursor)
  return store.transaction(async (tx) => {
    await activeUser(tx, actor._id)
    const rooms: RecentRoomPage['rooms'] = []
    let after = start
    let scanned = 0
    // Bound transaction work. A non-null cursor must be followed even for an empty filtered page.
    while (scanned < 40) {
      const size = Math.min(20, 40 - scanned)
      const batch = await tx.listRecent(actor._id, size, after)
      if (!batch.length) return { rooms, nextCursor: null }
      for (let index = 0; index < batch.length; index++) {
        const member = batch[index]
        scanned++
        after = { lastVisitedAt: member.lastVisitedAt, id: member._id }
        if (member.recentHidden !== true) {
          const room = await tx.get('rooms', member.roomId)
          if (
            room &&
            room.wechatAppId === actor.wechatAppId &&
            room.status === 'active' &&
            (room.expiresAt === null || room.expiresAt > now)
          ) {
            rooms.push({ ...preview(room), lastEnteredAt: member.lastVisitedAt })
          }
        }
        if (rooms.length === input.limit || scanned === 40) {
          return {
            rooms,
            nextCursor:
              index < batch.length - 1 || batch.length === size ? encode(actor._id, after) : null,
          }
        }
      }
      if (batch.length < size) return { rooms, nextCursor: null }
    }
    return { rooms, nextCursor: after ? encode(actor._id, after) : null }
  })
}
