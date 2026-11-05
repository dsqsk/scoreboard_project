import type { CommandReceipt, CommandRequest } from '@scoreboard/shared'
import type { Store, Transaction } from '../repositories/store'
import { AppError } from '../infrastructure/errors'
import { canonicalHash, meta, stableId } from '../infrastructure/ids'

export async function executeCommand(
  store: Store,
  actorId: string,
  command: CommandRequest,
  now: number,
  authorize: (tx: Transaction) => Promise<void>,
  operation: (tx: Transaction) => Promise<CommandReceipt>,
): Promise<CommandReceipt> {
  const id = stableId('cmd', actorId, command.requestId)
  const payloadHash = canonicalHash({ action: command.action, payload: command.payload })
  return store.transaction(async (tx) => {
    await authorize(tx)
    const existing = await tx.get('commands', id)
    if (existing) {
      if (existing.payloadHash !== payloadHash)
        throw new AppError('IDEMPOTENCY_MISMATCH', '同一请求标识不能使用不同参数')
      return existing.result
    }
    const result = await operation(tx)
    await tx.set('commands', {
      ...meta(id, now),
      actorUserId: actorId,
      action: command.action,
      payloadHash,
      result,
    })
    return result
  })
}
export async function checkRateLimit(
  store: Store,
  userId: string,
  now: number,
  group: string,
  max: number,
  requestKey?: string,
): Promise<void> {
  const windowStart = Math.floor(now / 60000) * 60000
  // Reuse one bucket per user/action group instead of accumulating one record per minute.
  const id = stableId('limit', userId, group)
  await store.transaction(async (tx) => {
    const old = await tx.get('rate_limits', id)
    const sameWindow = old?.windowStart === windowStart
    const count = sameWindow ? old.count : 0
    const requestKeys = sameWindow ? old.requestKeys : []
    if (requestKey && requestKeys.includes(requestKey)) return
    if (count >= max) throw new AppError('RATE_LIMITED', '操作过于频繁，请稍后重试')
    await tx.set('rate_limits', {
      ...(old ?? meta(id, now)),
      updatedAt: now,
      revision: (old?.revision ?? -1) + 1,
      windowStart,
      count: count + 1,
      requestKeys: requestKey ? [...requestKeys, requestKey] : requestKeys,
    })
  })
}
