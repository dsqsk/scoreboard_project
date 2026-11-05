import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createMysqlPool, createMysqlStore } from '../repositories/mysql-store'
import { createSessionService } from './auth'
import { createAvatarService } from './avatars'
import { createHttpApplication } from './application'

const appId = process.env.WECHAT_APP_ID ?? '',
  appSecret = process.env.WECHAT_APP_SECRET ?? ''
const signingKey = process.env.AVATAR_SIGNING_KEY ?? '',
  publicUrl = process.env.PUBLIC_BASE_URL ?? ''
const directory = process.env.AVATAR_DIRECTORY ?? '/var/lib/scoreboard/avatars'
const pool = createMysqlPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? '',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? '',
})
const store = createMysqlStore(pool)
const maintenance = () =>
  process.env.WRITE_ENABLED !== 'true' ||
  existsSync(process.env.MAINTENANCE_FILE ?? '/var/lib/scoreboard/MAINTENANCE')
const application = createHttpApplication({
  store,
  sessions: createSessionService(pool, { appId, appSecret }),
  avatars: createAvatarService({ directory, publicUrl, signingKey }),
  maintenance,
  async ready() {
    if (
      !appId ||
      !appSecret ||
      signingKey.length < 32 ||
      !(
        /^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?$/.test(publicUrl) ||
        (process.env.HTTP_ALLOW_INSECURE === 'true' &&
          process.env.NODE_ENV !== 'production' &&
          /^http:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(publicUrl))
      ) ||
      !process.env.DB_NAME ||
      !process.env.DB_USER
    )
      return false
    let connection
    try {
      connection = await pool.getConnection()
      const [result] = await connection.execute(
        "SELECT value_text FROM sb_migration_meta WHERE id='active_batch'",
      )
      return Array.isArray(result) && result.length === 1
    } catch {
      return false
    } finally {
      connection?.release()
    }
  },
})
const server = createServer(async (req, res) => {
  const trace = randomUUID(),
    start = performance.now()
  res.setHeader('X-Request-ID', trace)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  try {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += buffer.length
      if (length > 2 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: 'INVALID_ARGUMENT', message: '请求超过大小限制' },
          }),
        )
        return
      }
      chunks.push(buffer)
    }
    const output = await application({
      method: req.method ?? '',
      path: req.url ?? '/',
      authorization: req.headers.authorization,
      contentType: req.headers['content-type']?.split(';')[0],
      body: Buffer.concat(chunks),
      address: req.socket.remoteAddress ?? 'unknown',
    })
    res.writeHead(output.status, {
      'Content-Type': output.contentType ?? 'application/json; charset=utf-8',
    })
    res.end(Buffer.isBuffer(output.body) ? output.body : JSON.stringify(output.body))
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: '服务暂不可用' } }),
    )
  } finally {
    console.info(
      JSON.stringify({
        type: 'http-request',
        traceId: trace,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - start),
      }),
    )
  }
})
server.requestTimeout = 15000
server.headersTimeout = 10000
server.maxHeadersCount = 50
server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () =>
  console.info('scoreboard HTTP listening'),
)
async function shutdown() {
  server.close()
  await pool.end()
}
process.on('SIGTERM', () => {
  void shutdown()
})
process.on('SIGINT', () => {
  void shutdown()
})
