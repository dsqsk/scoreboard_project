import cloud from 'wx-server-sdk'
import { AppError } from './errors'

// The installed 3.x runtime supports these APIs; the community types omit them.
const runtimeCloud = cloud as typeof cloud & {
  readonly DYNAMIC_CURRENT_ENV: symbol
  init(options: { env: symbol }): void
  database(options: { throwOnNotFound: boolean }): ReturnType<typeof cloud.database>
}
let initialized = false

export function getCloud() {
  if (!initialized) {
    // The current runtime environment is independent of the caller's WeChat context.
    runtimeCloud.init({ env: runtimeCloud.DYNAMIC_CURRENT_ENV })
    initialized = true
  }
  return runtimeCloud
}

// 业务入口必须从可信云调用上下文获取身份，不接受 event 中的 openid。
export function requireWechatIdentity() {
  const { OPENID, APPID } = getCloud().getWXContext()
  if (!OPENID || !APPID) throw new AppError('UNAUTHENTICATED', '请从微信小程序访问')
  return { openId: OPENID, appId: APPID }
}
