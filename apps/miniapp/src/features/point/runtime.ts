import { backendScope } from '../../platform/backend'
import { backendTransport, backendEnvironment } from '../../platform/backend'
import Taro from '@tarojs/taro'
import { isMock, roomApi } from '../../runtime'
import { createMockPointApi } from './api'
import { createCloudPointApi } from './cloud'
import { createPointStore } from './store'
import type { PointOperation } from './store'
const key = 'scoreboard.point.mock.v1'
const namespace = `scoreboard.point.pending.v1.${backendScope}`
export const pointApi = isMock
  ? createMockPointApi(roomApi, {
      read: () => Taro.getStorageSync(key),
      write: (value) => Taro.setStorageSync(key, value),
    })
  : createCloudPointApi(backendEnvironment, backendTransport)
let sequence = 0
export const pointSession = createPointStore(
  pointApi,
  () => `point-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`,
  {
    read(userId) {
      const value: unknown = Taro.getStorageSync(`${namespace}.${userId}`)
      if (!value) return []
      if (
        !Array.isArray(value) ||
        !value.every(
          (item) =>
            item &&
            typeof item.roomId === 'string' &&
            typeof item.requestId === 'string' &&
            item.command &&
            ['prepare', 'claim', 'correct', 'post'].includes(item.command.kind),
        )
      )
        throw new Error('待确认打分操作无法读取，请保留数据并检查')
      return value as PointOperation[]
    },
    write(userId, value) {
      if (value.length) Taro.setStorageSync(`${namespace}.${userId}`, value)
      else Taro.removeStorageSync(`${namespace}.${userId}`)
    },
  },
)
