import { backendScope } from '../../platform/backend'
import Taro from '@tarojs/taro'
import { isMock, roomApi } from '../../runtime'
import { backendTransport } from '../../platform/backend'
import { createCloudDaAApi } from './api'
import { createMockDaAApi } from './mock'
import { createDaAStore } from './store'
import type { DaAPending } from './store'
const key = 'scoreboard.da-a.mock.v1'
const namespace = `scoreboard.da-a.pending.v1.${backendScope}`
export const daAApi = isMock
  ? createMockDaAApi(roomApi, {
      read: () => Taro.getStorageSync(key),
      write: (value) => Taro.setStorageSync(key, value),
    })
  : createCloudDaAApi(backendTransport.call)
let sequence = 0
export const daASession = createDaAStore(
  daAApi,
  () => `daa-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`,
  {
    read(userId) {
      const value: unknown = Taro.getStorageSync(`${namespace}.${userId}`)
      if (!value) return null
      const pending = value as DaAPending
      if (
        typeof pending.roomId !== 'string' ||
        typeof pending.userId !== 'string' ||
        typeof pending.requestId !== 'string' ||
        !pending.command ||
        !['prepare', 'delta'].includes(pending.command.kind)
      )
        throw new Error('待确认打大A操作无法读取，请保留数据检查')
      return pending
    },
    write(userId, value) {
      const key = `${namespace}.${userId}`
      if (value) Taro.setStorageSync(key, value)
      else Taro.removeStorageSync(key)
    },
  },
)
