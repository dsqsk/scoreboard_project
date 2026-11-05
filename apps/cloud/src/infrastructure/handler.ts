import type { ApiResult } from '@scoreboard/shared'
import { z } from 'zod'
import { AppError } from './errors'

// 不记录原始请求或身份数据；未知异常仅返回通用错误。
export function defineHandler<S extends z.ZodType, T>(
  schema: S,
  handler: (input: z.output<S>) => Promise<T>,
): (event: unknown) => Promise<ApiResult<T>> {
  return async (event) => {
    // WeChat injects userInfo/tcbContext. Ignore their contents; identity comes from getWXContext.
    // Keep strict validation for every other field, including identity-shaped payload fields.
    const input =
      event && typeof event === 'object' && !Array.isArray(event)
        ? Object.fromEntries(
            Object.entries(event).filter(([key]) => key !== 'userInfo' && key !== 'tcbContext'),
          )
        : event
    const parsed = schema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: '请求参数不正确' } }
    }
    try {
      return { ok: true, data: await handler(parsed.data) }
    } catch (error) {
      if (error instanceof AppError) {
        return { ok: false, error: { code: error.code, message: error.message } }
      }
      // Only emit known platform codes; never log an SDK error object or its message.
      let code: string | number = 'UNKNOWN'
      try {
        if (error && typeof error === 'object') {
          const value = 'errCode' in error ? error.errCode : 'code' in error ? error.code : null
          if (typeof value === 'number' && Number.isSafeInteger(value)) code = value
          else if (
            typeof value === 'string' &&
            [
              'DATABASE_TRANSACTION_CONFLICT',
              'DATABASE_TRANSACTION_FAIL',
              'DATABASE_TIMEOUT',
              'ECONNRESET',
              'ETIMEDOUT',
            ].includes(value)
          )
            code = value
        }
      } catch {}
      console.error('Unhandled cloud function error', { code })
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' } }
    }
  }
}
