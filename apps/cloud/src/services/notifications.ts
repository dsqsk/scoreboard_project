import type { Transaction } from '../repositories/store'
import { meta, stableId } from '../infrastructure/ids'

export async function recordChange(
  tx: Transaction,
  requestId: string,
  userId: string,
  roomId: string,
  now: number,
  activityId: string | null = null,
) {
  const id = stableId('change', userId, requestId)
  await tx.set('notification_outbox', {
    ...meta(id, now),
    roomId,
    activityId,
    changeId: id,
    status: 'pending',
    paginationCursor: null,
    attempts: 0,
    nextAttemptAt: now,
    leaseUntil: null,
  })
}
