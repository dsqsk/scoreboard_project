import type { Store } from '../repositories/store'
import { stableId, canonicalHash } from '../infrastructure/ids'

// Deploy separately with management-only invocation; never add this to the business API.
// This probe performs reads only and returns timings/counts rather than document contents.
export async function probePointReads(
  store: Store,
  input: unknown,
  clock: () => number = () => performance.now(),
) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('activityId' in input) ||
    typeof input.activityId !== 'string' ||
    !/^activity_[a-zA-Z0-9_-]{1,100}$/.test(input.activityId)
  )
    return { ok: false, code: 'INVALID_ARGUMENT' }
  const activityId = input.activityId
  const rounds = []
  for (let round = 0; round < 3; round++) {
    const sample = await store.transaction(async (tx) => {
      const started = clock()
      const expected = []
      for (let number = 1; number <= 15; number++) {
        const card = await tx.get('activity_cards', stableId('card', activityId, String(number)))
        if (!card) throw new Error('PROBE_INCOMPLETE_CARDS')
        expected.push(card)
      }
      const sequentialMs = clock() - started
      const batchStarted = clock()
      const actual = await tx.listPointCards(activityId)
      const batchMs = clock() - batchStarted
      const byId = (a: { _id: string }, b: { _id: string }) => a._id.localeCompare(b._id)
      if (canonicalHash(expected.sort(byId)) !== canonicalHash(actual.sort(byId)))
        throw new Error('PROBE_SNAPSHOT_MISMATCH')
      return { sequentialMs, batchMs, count: actual.length, consistent: true }
    })
    rounds.push(sample)
  }
  return { ok: true, rounds }
}
