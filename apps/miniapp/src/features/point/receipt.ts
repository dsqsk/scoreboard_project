import type { CommandReceipt, PointCommitState } from '@scoreboard/shared'
import type { PointCommand } from './api'
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const revision = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const nullableId = (v: unknown) => v === null || id(v)
export function isPointCommitState(v: unknown): v is PointCommitState {
  if (
    !object(v) ||
    !id(v.activityId) ||
    !revision(v.revision) ||
    v.status !== 'open' ||
    !object(v.earnedPoints) ||
    !Array.isArray(v.cards) ||
    v.cards.length !== 15 ||
    !object(v.change)
  )
    return false
  const ids = Object.keys(v.earnedPoints)
  if (
    ![2, 3].includes(ids.length) ||
    !ids.every(id) ||
    !Object.values(v.earnedPoints).every(revision)
  )
    return false
  const points: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]))
  const seen = new Set<number>()
  for (const c of v.cards) {
    if (
      !object(c) ||
      !revision(c.number) ||
      c.number < 1 ||
      c.number > 15 ||
      seen.has(c.number) ||
      !revision(c.revision) ||
      c.revision > v.revision ||
      !nullableId(c.ownerUserId) ||
      !nullableId(c.initialRecordedBy) ||
      !nullableId(c.lastModifiedBy)
    )
      return false
    seen.add(c.number)
    if (c.ownerUserId !== null) {
      if (!id(c.ownerUserId) || !ids.includes(c.ownerUserId)) return false
      points[c.ownerUserId]! += c.number
    }
  }
  if (
    !ids.every(
      (id) => v.earnedPoints && (v.earnedPoints as Record<string, unknown>)[id] === points[id],
    )
  )
    return false
  const c = v.change
  return (
    id(c.requestId) &&
    revision(c.number) &&
    c.number >= 1 &&
    c.number <= 15 &&
    nullableId(c.fromUserId) &&
    nullableId(c.toUserId) &&
    c.fromUserId !== c.toUserId &&
    (c.fromUserId === null || ids.includes(String(c.fromUserId))) &&
    (c.toUserId === null || ids.includes(String(c.toUserId))) &&
    id(c.actorUserId) &&
    typeof c.actorName === 'string' &&
    revision(c.createdAt)
  )
}
export function isPointReceipt(
  v: unknown,
  roomId: string,
  command: PointCommand,
  requestId: string,
): v is CommandReceipt {
  if (
    !object(v) ||
    v.requestId !== requestId ||
    v.roomId !== roomId ||
    !id(v.activityId) ||
    (command.kind !== 'prepare' && v.activityId !== command.activityId)
  )
    return false
  if (!('pointState' in v)) return true // Historical receipts retain the full-refresh fallback.
  if (command.kind !== 'claim' && command.kind !== 'correct') return false
  const p = v.pointState
  if (
    !isPointCommitState(p) ||
    !revision(v.roomRevision) ||
    !revision(v.activityRevision) ||
    p.activityId !== v.activityId ||
    p.revision !== v.activityRevision ||
    p.change.requestId !== requestId ||
    p.change.number !== command.number
  )
    return false
  const card = p.cards.find((c) => c.number === command.number)!
  return (
    card.revision === command.expectedCardRevision + 1 &&
    card.lastModifiedBy === p.change.actorUserId &&
    card.ownerUserId === p.change.toUserId &&
    (command.kind === 'claim'
      ? p.change.fromUserId === null &&
        p.change.toUserId === p.change.actorUserId &&
        id(card.initialRecordedBy) &&
        (command.expectedCardRevision !== 0 || card.initialRecordedBy === p.change.actorUserId)
      : p.change.fromUserId !== null && p.change.toUserId === command.ownerUserId)
  )
}
