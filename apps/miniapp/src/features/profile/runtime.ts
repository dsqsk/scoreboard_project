import { httpAvatars } from './avatar-runtime'
import { backendScope, isHttp } from '../../platform/backend'
import { getCloud } from '../../platform/cloud'
import Taro from '@tarojs/taro'
import { stores, roomApi, isMock } from '../../runtime'
import { createProfileStore } from './store'
import type { ProfilePending } from './store'
const namespace = `scoreboard.profile.pending.v1.${backendScope}`
let sequence = 0
const makeId = () => `profile-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`
export const profileSession = createProfileStore({
  makeId,
  async upload(userId, path) {
    if (isMock) return `cloud://mock/avatars/${userId}/${makeId()}.png`
    const info = await Taro.getImageInfo({ src: path })
    const extension = info.type.toLowerCase()
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(extension))
      throw new Error('请选择JPG、PNG或WebP头像')
    const stat = await new Promise<{ size: number }>((resolve, reject) =>
      Taro.getFileSystemManager().getFileInfo({ filePath: path, success: resolve, fail: reject }),
    )
    if (stat.size <= 0 || stat.size > 2 * 1024 * 1024) throw new Error('请选择不超过2MB的有效头像')
    if (isHttp) {
      const bytes = Taro.getFileSystemManager().readFileSync(path)
      if (!(bytes instanceof ArrayBuffer)) throw new Error('头像文件无法读取，请重新选择')
      return httpAvatars.upload(userId, bytes, `image/${extension === 'jpg' ? 'jpeg' : extension}`)
    }
    const cloud = await getCloud(process.env.TARO_APP_CLOUD_ENV ?? '')
    const uploaded = await cloud.uploadFile({
      cloudPath: `avatars/${userId}/${makeId()}.${extension}`,
      filePath: path,
    })
    return uploaded.fileID
  },
  async update(input, requestId) {
    if (!roomApi.updateProfile) throw new Error('资料接口尚未接入')
    await roomApi.updateProfile(input, requestId)
  },
  reload: () => stores.refreshIdentity(),
  read(userId) {
    return Taro.getStorageSync(`${namespace}.${userId}`) || null
  },
  write(userId, pending: ProfilePending | null) {
    const key = `${namespace}.${userId}`
    if (pending) Taro.setStorageSync(key, pending)
    else Taro.removeStorageSync(key)
  },
})
