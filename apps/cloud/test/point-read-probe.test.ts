import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from './memory-store'
import { meta, stableId } from '../src/infrastructure/ids'
import { probePointReads } from '../src/diagnostics/point-read-probe'
import type { Store } from '../src/repositories/store'

test('read probe compares sequential and indexed reads without writing or returning documents', async () => {
  const store = new MemoryStore()
  const activityId = 'activity_probe'
  await store.transaction(async (tx) => {
    for (let number = 1; number <= 15; number++)
      await tx.set('activity_cards', {
        ...meta(stableId('card', activityId, String(number)), 0),
        activityId,
        roomId: 'private-room',
        mode: 'point_ball',
        number,
        points: number,
        ownerUserId: 'private-user',
        updatedBy: null,
      })
  })
  let writes = 0
  let reads = 0
  let batches = 0
  const readOnly: Store = {
    transaction: (operation) =>
      store.transaction((tx) =>
        operation({
          ...tx,
          get: (collection, id) => {
            reads++
            return tx.get(collection, id)
          },
          listPointCards: (id) => {
            batches++
            return tx.listPointCards(id)
          },
          set: async () => {
            writes++
            throw new Error('probe must never write')
          },
        }),
      ),
  }
  let clock = 0
  const result = await probePointReads(readOnly, { activityId }, () => ++clock)
  assert.deepEqual(result, {
    ok: true,
    rounds: Array.from({ length: 3 }, () => ({
      sequentialMs: 1,
      batchMs: 1,
      count: 15,
      consistent: true,
    })),
  })
  assert.equal(reads, 45)
  assert.equal(batches, 3)
  assert.equal(writes, 0)
  assert.doesNotMatch(JSON.stringify(result), /private-room|private-user|activity_probe/)
  assert.deepEqual(await probePointReads(readOnly, { activityId: 'bad' }), {
    ok: false,
    code: 'INVALID_ARGUMENT',
  })
  await assert.rejects(probePointReads(new MemoryStore(), { activityId }), /INCOMPLETE_CARDS/)
  const inconsistent: Store = {
    transaction: (operation) =>
      store.transaction((tx) =>
        operation({
          ...tx,
          listPointCards: async () => [],
        }),
      ),
  }
  await assert.rejects(probePointReads(inconsistent, { activityId }), /SNAPSHOT_MISMATCH/)
})
