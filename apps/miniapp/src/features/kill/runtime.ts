import { backendScope } from '../../platform/backend'
import Taro from '@tarojs/taro'
import { isMock, roomApi } from '../../runtime'
import { createMockKillApi, unavailableCloudKillApi } from './api'
import { createKillStore } from './store'
import type { PendingKill } from './store'
const key = 'scoreboard.kill.mock.v1'
const pendingKey = `scoreboard.kill.pending.v1.${backendScope}`
let identityId = ''
const api = isMock
  ? createMockKillApi(roomApi, {
      read: () => Taro.getStorageSync(key),
      write: (value) => Taro.setStorageSync(key, value),
    })
  : unavailableCloudKillApi
let sequence = 0
export const killSession = createKillStore(
  {
    async get(roomId) {
      identityId = (await roomApi.getMe()).userId
      return api.get(roomId)
    },
    async execute(roomId, command, requestId) {
      identityId = (await roomApi.getMe()).userId
      return api.execute(roomId, command, requestId)
    },
  },
  () => `kill-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`,
  {
    read() {
      // open() resolves identity before accessing this user-scoped journal (see store).
      const value: unknown = Taro.getStorageSync(`${pendingKey}.${identityId}`)
      if (!value) return null
      const pending = value as PendingKill
      if (
        typeof pending.roomId !== 'string' ||
        typeof pending.requestId !== 'string' ||
        !pending.command ||
        !['deal', 'pot', 'transfer', 'save'].includes(pending.command.kind)
      )
        throw new Error('待确认操作无法读取，请保留本地数据并检查')
      return pending
    },
    write(value) {
      if (!identityId) throw new Error('身份尚未恢复，请刷新房间')
      if (value) Taro.setStorageSync(`${pendingKey}.${identityId}`, value)
      else Taro.removeStorageSync(`${pendingKey}.${identityId}`)
    },
  },
)
