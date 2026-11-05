import { createHash, randomBytes } from 'node:crypto'
import type { Caller } from '../domain/models'
import { AppError } from '../infrastructure/errors'
import { rows, type SqlPool } from '../repositories/mysql-store'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export function createSessionService(
  pool: SqlPool,
  config: { appId: string; appSecret: string },
  exchange = exchangeWechatCode,
  now = Date.now,
) {
  return {
    async login(code: string, address: string) {
      if (!config.appId || !config.appSecret)
        throw new AppError('INTERNAL_ERROR', '登录服务尚未就绪')
      if (!/^[a-zA-Z0-9_-]{1,256}$/.test(code))
        throw new AppError('INVALID_ARGUMENT', '登录凭据不正确')
      const c = await pool.getConnection()
      try {
        await c.beginTransaction()
        const id = hash(address),
          window = Math.floor(now() / 60000) * 60000
        await c.execute(
          'INSERT INTO sb_auth_limits(id,window_start,count_value) VALUES (?,?,1) ON DUPLICATE KEY UPDATE count_value=IF(window_start=VALUES(window_start),count_value+1,1),window_start=VALUES(window_start)',
          [id, window],
        )
        const limits = await rows<{ count_value: number }>(
          c,
          'SELECT count_value FROM sb_auth_limits WHERE id=? FOR UPDATE',
          [id],
        )
        await c.commit()
        if (limits[0].count_value > 20)
          throw new AppError('RATE_LIMITED', '登录过于频繁，请稍后重试')
      } catch (error) {
        try {
          await c.rollback()
        } catch {}
        throw error
      } finally {
        c.release()
      }
      const caller = await exchange(config.appId, config.appSecret, code)
      const token = randomBytes(32).toString('hex'),
        expiresAt = now() + 7 * 86400000
      return { caller, token, expiresAt }
    },
    async save(token: string, expiresAt: number, caller: Caller) {
      const c = await pool.getConnection()
      try {
        await c.execute(
          'INSERT INTO sb_sessions(token_hash,app_id,open_id,expires_at) VALUES (?,?,?,?)',
          [hash(token), caller.appId, caller.openId, expiresAt],
        )
      } finally {
        c.release()
      }
    },
    async authenticate(header: string | undefined): Promise<Caller> {
      if (!header || !/^Bearer [a-f0-9]{64}$/.test(header))
        throw new AppError('UNAUTHENTICATED', '请重新登录')
      const c = await pool.getConnection()
      try {
        const sessions = await rows<{
          app_id: string
          open_id: string
          expires_at: number
          revoked: number
        }>(c, 'SELECT app_id,open_id,expires_at,revoked FROM sb_sessions WHERE token_hash=?', [
          hash(header.slice(7)),
        ])
        const session = sessions[0]
        if (
          !session ||
          session.revoked ||
          Number(session.expires_at) <= now() ||
          session.app_id !== config.appId
        )
          throw new AppError('UNAUTHENTICATED', '请重新登录')
        return { appId: session.app_id, openId: session.open_id }
      } finally {
        c.release()
      }
    },
    async revoke(header: string) {
      const c = await pool.getConnection()
      try {
        await c.execute('UPDATE sb_sessions SET revoked=TRUE WHERE token_hash=?', [
          hash(header.slice(7)),
        ])
      } finally {
        c.release()
      }
    },
  }
}
export async function exchangeWechatCode(
  appId: string,
  appSecret: string,
  code: string,
): Promise<Caller> {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
  url.search = new URLSearchParams({
    appid: appId,
    secret: appSecret,
    js_code: code,
    grant_type: 'authorization_code',
  }).toString()
  let data: unknown
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' })
    if (!response.ok) throw new Error('wechat unavailable')
    data = await response.json()
  } catch {
    throw new AppError('UNAUTHENTICATED', '微信登录暂不可用，请重新登录')
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !('openid' in data) ||
    typeof data.openid !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(data.openid) ||
    ('errcode' in data && data.errcode !== 0)
  )
    throw new AppError('UNAUTHENTICATED', '微信登录凭据失效，请重新登录')
  return { appId, openId: data.openid }
}
