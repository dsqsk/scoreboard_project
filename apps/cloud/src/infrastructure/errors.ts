import type { ApiErrorCode } from '@scoreboard/shared'

export class AppError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}
