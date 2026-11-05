import type { ApiErrorCode } from '@scoreboard/shared'

export class RoomApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode | 'TRANSPORT_UNKNOWN' | 'INVALID_RESPONSE' | 'MAINTENANCE',
    message: string,
  ) {
    super(message)
    this.name = 'RoomApiError'
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '暂时无法完成，请稍后重试'
}
