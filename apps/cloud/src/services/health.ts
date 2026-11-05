import type { HealthResponse } from '@scoreboard/shared'

export async function getHealth(): Promise<HealthResponse> {
  return { service: 'scoreboard', status: 'ok' }
}
