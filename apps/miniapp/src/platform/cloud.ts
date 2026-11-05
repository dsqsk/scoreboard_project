import type Taro from '@tarojs/taro'
import type { FoundationRequest } from '@scoreboard/shared'
type CloudInstance = Pick<typeof Taro.cloud, 'init' | 'callFunction' | 'uploadFile'>
declare const wx:
  { cloud: { Cloud: new (options: { resourceEnv: string }) => CloudInstance } } | undefined
let activeEnv = ''
let flight: Promise<CloudInstance> | undefined
export function getCloud(env: string): Promise<CloudInstance> {
  if (flight && activeEnv === env) return flight
  activeEnv = env
  flight = (async () => {
    if (!env) throw new Error('未配置微信云环境')
    if (typeof wx === 'undefined' || !wx.cloud?.Cloud) throw new Error('请在微信小程序中使用云功能')
    const instance = new wx.cloud.Cloud({ resourceEnv: env })
    await instance.init()
    return instance
  })()
  const current = flight
  void current.catch(() => {
    if (flight === current) flight = undefined
  })
  return current
}
export async function initCloud(env: string): Promise<void> {
  await getCloud(env)
}
export async function callCloud(data: FoundationRequest): Promise<unknown> {
  const debug = process.env.NODE_ENV === 'development'
  const startedAt = debug ? Date.now() : 0
  let initialized = false
  let initializedAt = startedAt
  let success = false
  try {
    const instance = await getCloud(process.env.TARO_APP_CLOUD_ENV ?? '')
    initialized = true
    if (debug) initializedAt = Date.now()
    const result = (await instance.callFunction({ name: 'api', data })).result
    success = !(result && typeof result === 'object' && 'ok' in result && result.ok === false)
    return result
  } finally {
    if (debug) {
      try {
        const finishedAt = Date.now()
        console.info('[cloud-timing]', {
          action: data.action,
          initializationMs: (initialized ? initializedAt : finishedAt) - startedAt,
          callFunctionMs: initialized ? finishedAt - initializedAt : 0,
          totalMs: finishedAt - startedAt,
          success,
        })
      } catch {
        // Diagnostic logging must never change a request's result or exception.
      }
    }
  }
}
