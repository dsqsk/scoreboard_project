import { foundationRequestSchema } from '@scoreboard/shared'
import { z } from 'zod'
import type { Caller } from '../domain/models'
import { AppError } from '../infrastructure/errors'
import { defineHandler } from '../infrastructure/handler'
import { stableId } from '../infrastructure/ids'
import { resolveCaller } from '../services/identity'
import { createFoundation } from '../services/foundation'
import type { MysqlStore } from '../repositories/mysql-store'
import type { createSessionService } from './auth'
import type { createAvatarService } from './avatars'
import { activeUser } from '../services/access'

export interface HttpInput {
  method: string
  path: string
  authorization?: string
  contentType?: string
  body: Buffer
  address: string
}
export interface HttpOutput {
  status: number
  body: unknown
  contentType?: string
}
export interface HttpDependencies {
  store: MysqlStore
  sessions: ReturnType<typeof createSessionService>
  avatars: ReturnType<typeof createAvatarService>
  ready(): Promise<boolean>
  maintenance(): boolean
}
const json = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new AppError('INVALID_ARGUMENT', '请求格式不正确')
  }
}
export function createHttpApplication(deps: HttpDependencies) {
  const foundation = createFoundation({
    store: deps.store,
    avatarReferenceValidator: deps.avatars.validateReference,
    validateAvatar: deps.avatars.validate,
  })
  const callerActive = async (caller: Caller) =>
    deps.store.transaction((tx) => activeUser(tx, stableId('usr', caller.appId, caller.openId)))
  return async (input: HttpInput): Promise<HttpOutput> => {
    try {
      const url = new URL(input.path, 'http://localhost')
      if (input.method === 'GET' && url.pathname === '/healthz')
        return { status: 200, body: { ok: true } }
      if (input.method === 'GET' && url.pathname === '/readyz') {
        const ready = await deps.ready()
        return { status: ready ? 200 : 503, body: { ok: ready } }
      }
      if (input.method === 'GET' && url.pathname.startsWith('/avatars/content/')) {
        const content = await deps.avatars.content(
          url.pathname.slice('/avatars/content/'.length),
          Number(url.searchParams.get('expires')),
          url.searchParams.get('signature') ?? '',
        )
        return { status: 200, body: content.bytes, contentType: content.contentType }
      }
      if (
        input.method !== 'POST' ||
        !['/auth/wechat', '/auth/logout', '/api', '/avatars', '/avatars/resolve'].includes(
          url.pathname,
        )
      )
        return {
          status: 404,
          body: { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } },
        }
      if (
        deps.maintenance() &&
        url.pathname !== '/avatars/resolve' &&
        url.pathname !== '/auth/logout'
      )
        throw new AppError('MAINTENANCE', '维护中，请保留待确认操作后重试')
      if (!(await deps.ready()))
        return {
          status: 503,
          body: { ok: false, error: { code: 'INTERNAL_ERROR', message: '服务尚未就绪' } },
        }
      if (url.pathname === '/auth/wechat') {
        const { code } = z
          .object({ code: z.string().min(1).max(256) })
          .strict()
          .parse(json(input.body))
        const session = await deps.sessions.login(code, input.address)
        await resolveCaller(deps.store, session.caller, Date.now())
        await deps.sessions.save(session.token, session.expiresAt, session.caller)
        return {
          status: 200,
          body: { ok: true, data: { accessToken: session.token, expiresAt: session.expiresAt } },
        }
      }
      const caller = await deps.sessions.authenticate(input.authorization)
      if (url.pathname === '/auth/logout') {
        await deps.sessions.revoke(input.authorization!)
        return { status: 200, body: { ok: true, data: {} } }
      }
      if (url.pathname === '/api') {
        const handle = defineHandler(foundationRequestSchema, (request) =>
          deps.store.request(() => foundation.dispatch(request, caller)),
        )
        const result = await handle(json(input.body))
        return {
          status: !result.ok && result.error.code === 'UNAUTHENTICATED' ? 401 : 200,
          body: result,
        }
      }
      const actor = await callerActive(caller)
      if (url.pathname === '/avatars')
        return {
          status: 200,
          body: {
            ok: true,
            data: await deps.avatars.upload(actor._id, input.contentType ?? '', input.body),
          },
        }
      const { fileIds } = z
        .object({ fileIds: z.array(z.string().min(1).max(1024)).max(50) })
        .strict()
        .parse(json(input.body))
      return { status: 200, body: { ok: true, data: await deps.avatars.resolve(fileIds) } }
    } catch (error) {
      if (!(error instanceof AppError) && !(error instanceof z.ZodError))
        console.error(
          JSON.stringify({
            type: 'http-error',
            code:
              error &&
              typeof error === 'object' &&
              'code' in error &&
              typeof error.code === 'string' &&
              /^[A-Z0-9_]{1,64}$/.test(error.code)
                ? error.code
                : 'INTERNAL_ERROR',
          }),
        )
      const app =
        error instanceof AppError
          ? error
          : error instanceof z.ZodError
            ? new AppError('INVALID_ARGUMENT', '请求参数不正确')
            : new AppError('INTERNAL_ERROR', '服务暂不可用，请稍后重试')
      return {
        status:
          app.code === 'UNAUTHENTICATED'
            ? 401
            : app.code === 'MAINTENANCE'
              ? 503
              : app.code === 'INVALID_ARGUMENT'
                ? 400
                : app.code === 'FORBIDDEN'
                  ? 403
                  : 500,
        body: { ok: false, error: { code: app.code, message: app.message } },
      }
    }
  }
}
