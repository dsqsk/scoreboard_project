import type { Collections } from '../domain/models'
import type { Collection } from '../repositories/store'
import { COLLECTIONS } from '../repositories/mysql-schema'
import { canonicalHash, stableId } from '../infrastructure/ids'
import { validatePointResult } from '../services/point-rules'
export interface Archive {
  schemaVersion: 1
  environmentId: string
  exportedAt: string | number
  consistentSnapshot: boolean
  collections: { [K in Collection]: Collections[K][] }
}
function check(condition: unknown, issue: string): asserts condition {
  if (!condition) throw new Error(`Archive invalid: ${issue}`)
}
export function archiveDigest(archive: Archive): string {
  return canonicalHash(
    Object.fromEntries(
      COLLECTIONS.map((name) => [
        name,
        [...archive.collections[name]].sort((a, b) => a._id.localeCompare(b._id)),
      ]),
    ),
  )
}
export function validateArchive(input: unknown): Archive {
  check(input && typeof input === 'object', 'root')
  const a = input as Archive
  check(
    a.schemaVersion === 1 &&
      typeof a.environmentId === 'string' &&
      typeof a.consistentSnapshot === 'boolean' &&
      a.collections &&
      typeof a.collections === 'object',
    'manifest',
  )
  check(
    Object.keys(a.collections).length === COLLECTIONS.length &&
      Object.keys(a.collections).every((name) => (COLLECTIONS as readonly string[]).includes(name)),
    'collection names',
  )
  const maps = Object.fromEntries(
    COLLECTIONS.map((name) => {
      check(Array.isArray(a.collections[name]), `array ${name}`)
      const map = new Map<string, Collections[Collection]>()
      for (const doc of a.collections[name]) {
        check(
          doc &&
            typeof doc === 'object' &&
            typeof doc._id === 'string' &&
            /^[a-zA-Z0-9_-]{1,128}$/.test(doc._id),
          `id ${name}`,
        )
        check(
          doc.schemaVersion === 1 &&
            Number.isSafeInteger(doc.revision) &&
            doc.revision >= 0 &&
            Number.isSafeInteger(doc.createdAt) &&
            Number.isSafeInteger(doc.updatedAt),
          `meta ${name}`,
        )
        check(!map.has(doc._id), `duplicate ${name}`)
        const numeric = (value: unknown): void => {
          if (typeof value === 'number') check(Number.isSafeInteger(value), 'unsafe numeric value')
          else if (value && typeof value === 'object')
            for (const v of Object.values(value)) numeric(v)
        }
        numeric(doc)
        map.set(doc._id, doc)
      }
      return [name, map]
    }),
  ) as { [K in Collection]: Map<string, Collections[K]> }
  const has = (name: Collection, id: string | null | undefined) => !id || maps[name].has(id)
  for (const user of a.collections.users)
    check(user._id === stableId('usr', user.wechatAppId, user.wechatOpenId), 'user identity')
  for (const room of a.collections.rooms)
    check(
      has('users', room.createdBy) &&
        has('activities', room.activeActivityId) &&
        has('room_codes', room.activeCodeId),
      'room references',
    )
  for (const code of a.collections.room_codes) check(has('rooms', code.roomId), 'code room')
  for (const member of a.collections.room_members)
    check(has('rooms', member.roomId) && has('users', member.userId), 'membership references')
  for (const activity of a.collections.activities) {
    check(
      has('rooms', activity.roomId) &&
        has('users', activity.createdBy) &&
        Array.isArray(activity.participantIds) &&
        new Set(activity.participantIds).size === activity.participantIds.length &&
        activity.participantIds.every((id) => has('users', id)),
      'activity references',
    )
    check(
      activity.participants.length === activity.participantIds.length &&
        activity.participants.every((p) => activity.participantIds.includes(p.userId)),
      'frozen participants',
    )
    if (activity.mode === 'point_ball') {
      const cards = a.collections.activity_cards
        .filter((card) => card.activityId === activity._id)
        .sort((x, y) => x.number - y.number)
      check(cards.length === 15, 'point card count')
      const earned = Object.fromEntries(activity.participantIds.map((id) => [id, 0]))
      for (const [i, card] of cards.entries()) {
        check(
          card._id === stableId('card', activity._id, String(i + 1)) &&
            card.roomId === activity.roomId &&
            card.number === i + 1 &&
            card.points === i + 1 &&
            card.mode === 'point_ball' &&
            (card.ownerUserId === null || activity.participantIds.includes(card.ownerUserId)),
          'point card',
        )
        if (card.ownerUserId) earned[card.ownerUserId] += card.points
      }
      for (const id of activity.participantIds) {
        const score = a.collections.activity_scores.find(
          (score) => score.activityId === activity._id && score.userId === id,
        )
        check(
          score &&
            score.earnedPoints === earned[id] &&
            score.ownedCardCount === cards.filter((card) => card.ownerUserId === id).length,
          'point score projection',
        )
      }
    }
  }
  for (const name of [
    'activity_scores',
    'activity_cards',
    'result_slots',
    'point_changes',
  ] as const)
    for (const doc of a.collections[name])
      check(has('rooms', doc.roomId) && has('activities', doc.activityId), 'activity reference')
  for (const score of a.collections.activity_scores) check(has('users', score.userId), 'score user')
  for (const command of a.collections.commands)
    check(
      has('users', command.actorUserId) &&
        /^[a-f0-9]{64}$/.test(command.payloadHash) &&
        command._id === stableId('cmd', command.actorUserId, command.result.requestId),
      'command receipt',
    )
  for (const result of a.collections.point_results) {
    validatePointResult(result.result)
    check(
      has('rooms', result.roomId) && has('activities', result.result.activityId),
      'result references',
    )
  }
  for (const entry of a.collections.da_a_entries)
    check(
      has('rooms', entry.roomId) &&
        has('activities', entry.entry.activityId) &&
        has('users', entry.entry.userId) &&
        entry.entry.roomId === entry.roomId,
      'entry references',
    )
  const walk = (
    name: 'point_changes' | 'point_results' | 'da_a_entries',
    head: string | null,
    roomId: string,
    activityId?: string,
  ) => {
    const seen = new Set<string>()
    let cursor = head
    while (cursor) {
      check(!seen.has(cursor), 'history cycle')
      seen.add(cursor)
      const row = maps[name].get(cursor)
      check(
        row &&
          row.roomId === roomId &&
          (!activityId || ('activityId' in row && row.activityId === activityId)),
        'history link',
      )
      cursor = row.previousId
    }
    return [...seen].map((id) => maps[name].get(id)!)
  }
  for (const activity of a.collections.activities)
    walk('point_changes', activity.latestPointChangeId ?? null, activity.roomId, activity._id)
  const compareTotals = (actual: Record<string, number>, expected: Record<string, number>) =>
    check(
      new Set([...Object.keys(actual), ...Object.keys(expected)]).size === 0 ||
        [...new Set([...Object.keys(actual), ...Object.keys(expected)])].every(
          (id) => (actual[id] ?? 0) === (expected[id] ?? 0),
        ),
      'cumulative totals',
    )
  for (const totals of a.collections.point_totals) {
    const expected: Record<string, number> = {}
    for (const row of walk('point_results', totals.latestResultId, totals.roomId))
      if ('result' in row)
        for (const [id, value] of Object.entries(row.result.deltas))
          expected[id] = (expected[id] ?? 0) + value
    compareTotals(totals.totals, expected)
  }
  for (const totals of a.collections.da_a_totals) {
    const expected: Record<string, number> = {}
    for (const row of walk('da_a_entries', totals.latestEntryId, totals.roomId))
      if ('entry' in row)
        expected[row.entry.userId] = (expected[row.entry.userId] ?? 0) + row.entry.deltaUnits
    compareTotals(totals.totalsUnits, expected)
  }
  return a
}
