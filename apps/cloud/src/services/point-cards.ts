import type { Activity } from '../domain/models'
import type { Transaction } from '../repositories/store'
import { stableId } from '../infrastructure/ids'
import { AppError } from '../infrastructure/errors'

// Shared by snapshots and commands; the query stays inside the caller's transaction.
export async function readPointCards(tx: Transaction, activity: Activity) {
  const cards = await tx.listPointCards(activity._id)
  if (!Array.isArray(cards) || cards.length !== 15)
    throw new AppError('INTERNAL_ERROR', '公共牌资料不完整')
  cards.sort((a, b) => a.number - b.number)
  for (const [index, card] of cards.entries()) {
    const number = index + 1
    if (
      card._id !== stableId('card', activity._id, String(number)) ||
      card.roomId !== activity.roomId ||
      card.activityId !== activity._id ||
      card.number !== number ||
      card.points !== number ||
      card.mode !== 'point_ball' ||
      (card.ownerUserId !== null && !activity.participantIds.includes(card.ownerUserId))
    )
      throw new AppError('INTERNAL_ERROR', '公共牌资料不完整')
  }
  return cards
}
