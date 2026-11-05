import { backendTransport, backendEnvironment, backendScope, isMock } from './platform/backend'
export { isMock } from './platform/backend'
import Taro from '@tarojs/taro'
import { createMockRoomApi } from './modules/room-api/mock'
import { createCloudRoomApi } from './modules/room-api/cloud'
import { createAppStores } from './stores/create-stores'
import type { PendingCommand } from './stores/create-stores'

const pendingNamespace = `scoreboard.pending.v1.${backendScope}`
const mockKey = 'scoreboard.mock.v1'
export const roomApi = isMock
  ? createMockRoomApi({
      storage: {
        read: () => Taro.getStorageSync(mockKey),
        write: (value) => Taro.setStorageSync(mockKey, value),
      },
    })
  : createCloudRoomApi(backendEnvironment, backendTransport)

let counter = 0
export const stores = createAppStores(
  roomApi,
  () => `${Date.now()}-${++counter}-${Math.random().toString(36).slice(2)}`,
  {
    read(userId) {
      const value: unknown = Taro.getStorageSync(`${pendingNamespace}.${userId}`)
      if (!value || typeof value !== 'object') return null
      const command = value as Partial<PendingCommand>
      return typeof command.requestId === 'string' &&
        typeof command.signature === 'string' &&
        /^(create|join):/.test(command.signature)
        ? { requestId: command.requestId, signature: command.signature }
        : null
    },
    write(value, userId) {
      const key = `${pendingNamespace}.${userId}`
      if (value) Taro.setStorageSync(key, value)
      else Taro.removeStorageSync(key)
    },
  },
  {
    read(userId) {
      return Taro.getStorageSync(`${pendingNamespace}.recent.${userId}`) || null
    },
    write(userId, value) {
      const key = `${pendingNamespace}.recent.${userId}`
      if (value) Taro.setStorageSync(key, value)
      else Taro.removeStorageSync(key)
    },
  },
)
