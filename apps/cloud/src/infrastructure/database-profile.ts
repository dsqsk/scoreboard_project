import type { WxStoreObservation, WxStoreObserver } from '../repositories/wx-store'

export function profileDatabase<T>(
  handler: (event: unknown, observer: WxStoreObserver) => Promise<T>,
  actions: ReadonlySet<string>,
  emit: (profile: DatabaseProfile) => void,
) {
  return async (event: unknown): Promise<T> => {
    const rawAction = event && typeof event === 'object' && 'action' in event ? event.action : null
    const profile: DatabaseProfile = {
      type: 'db-profile',
      action: typeof rawAction === 'string' && actions.has(rawAction) ? rawAction : 'invalid',
      operations: [],
      transactions: {
        count: 0,
        failures: 0,
        wallMs: 0,
        callbackMs: 0,
        attempts: 0,
        beginCommitSdkMs: 0,
      },
    }
    const observer = (event: WxStoreObservation) => {
      if (event.kind === 'operation') {
        let row = profile.operations.find(
          (row) => row.collection === event.collection && row.operation === event.operation,
        )
        if (!row) {
          row = {
            collection: event.collection,
            operation: event.operation,
            count: 0,
            failures: 0,
            durationMs: 0,
          }
          profile.operations.push(row)
        }
        row.count++
        row.failures += event.success ? 0 : 1
        row.durationMs += event.durationMs
      } else {
        const totals = profile.transactions
        totals.count++
        totals.failures += event.success ? 0 : 1
        totals.wallMs += event.wallMs
        totals.callbackMs += event.callbackMs
        totals.attempts += event.attempts
        // Includes begin/commit, retry gaps and SDK overhead; not an isolated commit measurement.
        totals.beginCommitSdkMs += Math.max(0, event.wallMs - event.callbackMs)
      }
    }
    try {
      return await handler(event, observer)
    } finally {
      try {
        emit(profile)
      } catch {}
    }
  }
}

export interface DatabaseProfile {
  type: 'db-profile'
  action: string
  operations: {
    collection: string
    operation: 'get' | 'set' | 'query'
    count: number
    failures: number
    durationMs: number
  }[]
  transactions: {
    count: number
    failures: number
    wallMs: number
    callbackMs: number
    attempts: number
    beginCommitSdkMs: number
  }
}
