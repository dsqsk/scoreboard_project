import { backendScope } from '../../platform/backend'
import Taro from '@tarojs/taro'
import { isMock, roomApi } from '../../runtime'
import { createMockPokerApi, unavailableCloudPokerApi } from './api'
import { createPokerStore } from './store'
import type { PendingPoker } from './store'
const key = 'scoreboard.poker.mock.v1'
const namespace = `scoreboard.poker.pending.v1.${backendScope}`
export const pokerApi = isMock
  ? createMockPokerApi(roomApi, {
      read: () => Taro.getStorageSync(key),
      write: (value) => Taro.setStorageSync(key, value),
    })
  : unavailableCloudPokerApi
let sequence = 0
export const pokerSession = createPokerStore(
  pokerApi,
  () => `poker-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`,
  {
    read(userId) {
      const value: unknown = Taro.getStorageSync(`${namespace}.${userId}`)
      if (!value) return null
      const pending = value as PendingPoker
      if (
        typeof pending.roomId !== 'string' ||
        typeof pending.requestId !== 'string' ||
        !pending.command ||
        !['da_a', 'dui_jia'].includes(pending.command.mode)
      )
        throw new Error('待确认扑克操作无法读取，请保留数据并检查')
      return pending
    },
    write(userId, value) {
      if (value) Taro.setStorageSync(`${namespace}.${userId}`, value)
      else Taro.removeStorageSync(`${namespace}.${userId}`)
    },
  },
)
