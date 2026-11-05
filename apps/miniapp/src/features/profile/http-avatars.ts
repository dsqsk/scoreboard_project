import { RoomApiError } from '../../modules/room-api/errors'
export const isPersistentAvatar = (v: string) =>
  v.startsWith('cloud://') || /^avatar:v1:usr_[a-f0-9]{64}:[a-f0-9]{32}\.(png|jpg|webp)$/.test(v)
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
type Post = (
  path: '/avatars' | '/avatars/resolve',
  data: unknown,
  contentType?: string,
) => Promise<unknown>
function unwrap(value: unknown): Record<string, unknown> {
  if (object(value) && value.ok === false && object(value.error))
    throw new RoomApiError(
      value.error.code === 'MAINTENANCE' ? 'MAINTENANCE' : 'INVALID_RESPONSE',
      typeof value.error.message === 'string' ? value.error.message : '头像服务暂不可用',
    )
  if (!object(value) || value.ok !== true || !object(value.data))
    throw new RoomApiError('INVALID_RESPONSE', '头像服务响应异常')
  return value.data
}
export function createHttpAvatars(post: Post, now: () => number = Date.now) {
  const cache = new Map<string, { url: string; until: number }>()
  const flights = new Map<string, Promise<string | undefined>>()
  return {
    async upload(userId: string, bytes: ArrayBuffer, type: string) {
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(type) ||
        !bytes.byteLength ||
        bytes.byteLength > 2 * 1024 * 1024
      )
        throw new Error('请选择不超过2MB的JPG、PNG或WebP头像')
      const response = unwrap(await post('/avatars', bytes, type))
      if (
        typeof response.avatarFileId !== 'string' ||
        !isPersistentAvatar(response.avatarFileId) ||
        !response.avatarFileId.startsWith(`avatar:v1:${userId}:`)
      )
        throw new Error('头像上传结果异常，请重试')
      return response.avatarFileId
    },
    resolve(fileId: string, force = false): Promise<string | undefined> {
      const saved = cache.get(fileId)
      if (!force && saved && saved.until > now()) return Promise.resolve(saved.url)
      const previous = flights.get(fileId)
      if (previous) return previous
      const current = (async () => {
        const response = unwrap(await post('/avatars/resolve', { fileIds: [fileId] }))
        if (!object(response.urls) || !Array.isArray(response.unavailable))
          throw new Error('头像地址响应异常')
        const url = response.urls[fileId]
        if (response.unavailable.includes(fileId)) {
          cache.delete(fileId)
          return undefined
        }
        if (typeof url !== 'string' || !/^https:\/\/[a-z\d.-]+(?::\d+)?\//i.test(url))
          throw new Error('头像地址无效')
        cache.set(fileId, { url, until: now() + 55 * 60 * 1000 })
        return url
      })()
      flights.set(fileId, current)
      void current
        .finally(() => {
          if (flights.get(fileId) === current) flights.delete(fileId)
        })
        .catch(() => {})
      return current
    },
  }
}
