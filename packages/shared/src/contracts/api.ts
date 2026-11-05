export type ApiErrorCode =
  | 'MAINTENANCE'
  | 'INVALID_ARGUMENT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'
  | 'STALE_CONTEXT'
  | 'RULE_NOT_CONFIGURED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'RATE_LIMITED'
  | 'ALREADY_POSTED'

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: ApiErrorCode; message: string } }

export interface HealthResponse {
  service: 'scoreboard'
  status: 'ok'
}

export interface WechatSession {
  accessToken: string
  expiresAt: number
}
export interface AvatarUploadResponse {
  avatarFileId: string
}
export interface AvatarResolveResponse {
  urls: Record<string, string>
  unavailable: string[]
}
