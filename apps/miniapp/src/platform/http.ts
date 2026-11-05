import type { FoundationRequest } from '@scoreboard/shared'
export interface HttpResponse {
  statusCode: number
  data: unknown
}
export interface HttpPorts {
  login(): Promise<{ code: string }>
  request(input: {
    url: string
    data: unknown
    header: Record<string, string>
  }): Promise<HttpResponse>
  now?(): number
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const maintenance = {
  ok: false,
  error: { code: 'MAINTENANCE', message: '服务维护中，请稍后重试；待确认操作已保留。' },
}
class LoginFailure extends Error {
  constructor(readonly envelope: unknown) {
    super('无法恢复登录，请重试')
  }
}
export function validateHttpOrigin(base: string, allowInsecure = false) {
  const url = base.replace(/\/$/, '')
  if (
    !/^https:\/\/[a-z\d.-]+(?::\d+)?$/i.test(url) &&
    !(allowInsecure && /^http:\/\/[a-z\d.-]+(?::\d+)?$/i.test(url))
  )
    throw new Error('请配置合法HTTPS服务地址；开发HTTP地址仅限开发模式显式启用')
  return url
}
export function createHttpTransport(base: string, ports: HttpPorts, allowInsecure = false) {
  const url = base.replace(/\/$/, '')
  function validate() {
    validateHttpOrigin(base, allowInsecure)
  }
  const now = ports.now ?? Date.now
  type Session = { accessToken: string; expiresAt: number }
  let session: Session | undefined
  let flight: Promise<Session> | undefined
  async function authenticate(): Promise<Session> {
    validate()
    const { code } = await ports.login()
    if (!code) throw new Error('微信登录失败，请重试')
    const response = await ports.request({
      url: `${url}/auth/wechat`,
      data: { code },
      header: { 'content-type': 'application/json' },
    })
    if (response.statusCode === 503) throw new LoginFailure(maintenance)
    const body = response.data
    if (response.statusCode !== 200 || !object(body) || body.ok !== true) {
      if (object(body) && body.ok === false && object(body.error)) throw new LoginFailure(body)
      throw new Error('登录响应异常，请重试')
    }
    const value = body.data
    if (
      !object(value) ||
      typeof value.accessToken !== 'string' ||
      !value.accessToken ||
      typeof value.expiresAt !== 'number' ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now()
    )
      throw new Error('登录响应异常，请重试')
    session = { accessToken: value.accessToken, expiresAt: value.expiresAt }
    return session
  }
  function ensure(): Promise<Session> {
    if (session && session.expiresAt > now()) return Promise.resolve(session)
    if (flight) return flight
    const current = authenticate()
    flight = current
    void current
      .finally(() => {
        if (flight === current) flight = undefined
      })
      .catch(() => {})
    return current
  }
  async function post(
    path: '/api' | '/avatars' | '/avatars/resolve',
    data: unknown,
    contentType = 'application/json',
  ): Promise<unknown> {
    validate()
    try {
      let active = await ensure()
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await ports.request({
          url: `${url}${path}`,
          data,
          header: {
            'content-type': contentType,
            Authorization: `Bearer ${active.accessToken}`,
          },
        })
        if (response.statusCode === 503) return maintenance
        if (response.statusCode === 401) {
          if (session === active) session = undefined
          if (attempt === 0) {
            active = await ensure()
            continue
          }
          return { ok: false, error: { code: 'UNAUTHENTICATED', message: '登录已失效，请重试' } }
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          if (object(response.data) && response.data.ok === false && object(response.data.error))
            return response.data
          throw new Error('HTTP请求结果未知，请确认原操作')
        }
        return response.data
      }
    } catch (error) {
      if (error instanceof LoginFailure) return error.envelope
      throw error
    }
  }
  return { init: validate, call: (data: FoundationRequest) => post('/api', data), post }
}
