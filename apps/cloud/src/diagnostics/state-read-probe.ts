import type { Store } from '../repositories/store'
import { createPointService } from '../services/point'

// Management-only diagnostic. Never return snapshots or allow writes through this store.
export async function probePointState(store: Store, input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('activityId' in input) ||
    typeof input.activityId !== 'string' ||
    !/^activity_[a-zA-Z0-9_-]{1,100}$/.test(input.activityId)
  )
    return { ok: false, code: 'INVALID_ARGUMENT' }
  const activityId = input.activityId
  const readOnly: Store = {
    transaction: (operation) =>
      store.transaction((tx) =>
        operation({
          ...tx,
          set: async () => {
            throw new Error('DIAGNOSTIC_WRITE_BLOCKED')
          },
        }),
      ),
  }
  const context = await readOnly.transaction(async (tx) => {
    const activity = await tx.get('activities', activityId)
    if (!activity || activity.mode !== 'point_ball') throw new Error('DIAGNOSTIC_NO_ACTIVITY')
    const actor = await tx.get('users', activity.participantIds[0])
    if (!actor) throw new Error('DIAGNOSTIC_NO_USER')
    return { roomId: activity.roomId, actor }
  })
  const service = createPointService(readOnly)
  const samples = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    const snapshot = await service.getState({ roomId: context.roomId }, context.actor, Date.now())
    const stateMs = performance.now() - start
    const serializeStart = performance.now()
    const payloadBytes = Buffer.byteLength(JSON.stringify(snapshot))
    samples.push({
      stateMs,
      serializeMs: performance.now() - serializeStart,
      payloadBytes,
      results: snapshot.results.length,
      changes: snapshot.activity?.changes.length ?? 0,
    })
  }
  return { ok: true, samples }
}
