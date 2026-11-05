import Taro from '@tarojs/taro'
import { initCloud, callCloud } from './cloud'
import { createHttpTransport } from './http'
export const backendMode = process.env.TARO_APP_BACKEND ?? 'mock'
export const isHttp = backendMode === 'http'
export const isMock = backendMode === 'mock'
// Existing cloud/mock watchers may not have loaded the new HTTP build variables.
// Read HTTP-only configuration only when that transport is selected.
const base = isHttp ? (process.env.TARO_APP_API_BASE_URL ?? '') : ''
export const backendScope = isMock
  ? 'mock'
  : isHttp
    ? `http.${encodeURIComponent(base.replace(/\/$/, ''))}`
    : process.env.TARO_APP_CLOUD_ENV || 'unconfigured'
export const backendEnvironment = isHttp ? base : (process.env.TARO_APP_CLOUD_ENV ?? '')
export const httpTransport = createHttpTransport(
  base,
  {
    login: () => Taro.login(),
    request: async (input) => {
      const startedAt = Date.now()
      try {
        const result = await Taro.request({ ...input, method: 'POST', timeout: 15000 })
        return { statusCode: result.statusCode, data: result.data }
      } catch (error) {
        // Only fixed classifications are logged: never request data, headers or raw errors.
        try {
          const message =
            error &&
            typeof error === 'object' &&
            'errMsg' in error &&
            typeof error.errMsg === 'string'
              ? error.errMsg
              : error instanceof Error
                ? error.message
                : ''
          const reason =
            [
              'ERR_CONNECTION_RESET',
              'ERR_CONNECTION_CLOSED',
              'ERR_CONNECTION_REFUSED',
              'ERR_NAME_NOT_RESOLVED',
              'ERR_CERT_AUTHORITY_INVALID',
              'ERR_CERT_DATE_INVALID',
              'ERR_CERT_COMMON_NAME_INVALID',
              'ERR_SSL_PROTOCOL_ERROR',
              'ERR_TIMED_OUT',
            ].find((code) => message.includes(code)) ??
            (/not in domain list/i.test(message)
              ? 'DOMAIN_NOT_ALLOWED'
              : /timeout|timed out/i.test(message)
                ? 'TIMEOUT'
                : /ssl|tls|certificate/i.test(message)
                  ? 'TLS_ERROR'
                  : 'UNKNOWN_NETWORK_ERROR')
          const path = ['/auth/wechat', '/api', '/avatars', '/avatars/resolve'].find((path) =>
            input.url.endsWith(path),
          )
          console.error('[http-connection]', { path, reason, elapsedMs: Date.now() - startedAt })
        } catch {
          // Diagnostics must preserve the original failure and pending-command handling.
        }
        throw error
      }
    },
  },
  isHttp &&
    process.env.NODE_ENV === 'development' &&
    process.env.TARO_APP_HTTP_ALLOW_INSECURE === 'true',
)
export const backendTransport = isHttp ? httpTransport : { init: initCloud, call: callCloud }
