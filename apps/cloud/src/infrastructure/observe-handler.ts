import type { ApiResult } from '@scoreboard/shared'

export interface RequestTiming {
  action: string
  durationMs: number
  success: boolean
}

export function observeHandler<T>(
  handler: (event: unknown) => Promise<ApiResult<T>>,
  actions: ReadonlySet<string>,
  emit: (timing: RequestTiming) => void,
  now: () => number = () => performance.now(),
) {
  return async (event: unknown): Promise<ApiResult<T>> => {
    const start = now()
    const rawAction = event && typeof event === 'object' && 'action' in event ? event.action : null
    const action = typeof rawAction === 'string' && actions.has(rawAction) ? rawAction : 'invalid'
    let success = false
    try {
      const result = await handler(event)
      success = result.ok
      return result
    } finally {
      // Observability must not change an already committed command's response.
      try {
        emit({ action, durationMs: Math.max(0, Math.round(now() - start)), success })
      } catch {}
    }
  }
}
