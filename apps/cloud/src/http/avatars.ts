import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { validateAvatarContent } from '../services/avatar'
import { AppError } from '../infrastructure/errors'

export const avatarKey = (reference: string) => createHash('sha256').update(reference).digest('hex')
export function createAvatarService(
  config: { directory: string; publicUrl: string; signingKey: string },
  now = Date.now,
) {
  const path = (key: string) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new AppError('INVALID_ARGUMENT', '头像引用不正确')
    return join(config.directory, key)
  }
  const signature = (key: string, expires: number) =>
    createHmac('sha256', config.signingKey).update(`${key}:${expires}`).digest('hex')
  return {
    validateReference(reference: string, userId: string) {
      if (!new RegExp(`^avatar:v1:${userId}:[a-f0-9]{32}\\.(png|jpg|webp)$`).test(reference))
        throw new AppError('INVALID_ARGUMENT', '请上传本人选择的头像')
    },
    async validate(reference: string) {
      validateAvatarContent(await readFile(path(avatarKey(reference))))
    },
    async upload(userId: string, contentType: string, bytes: Buffer) {
      validateAvatarContent(bytes)
      const ext =
        contentType === 'image/png'
          ? 'png'
          : contentType === 'image/jpeg'
            ? 'jpg'
            : contentType === 'image/webp'
              ? 'webp'
              : null
      if (!ext) throw new AppError('INVALID_ARGUMENT', '头像格式不正确')
      const reference = `avatar:v1:${userId}:${randomBytes(16).toString('hex')}.${ext}`
      await mkdir(config.directory, { recursive: true, mode: 0o700 })
      const file = path(avatarKey(reference)),
        temp = `${file}.tmp`
      await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temp, file)
      return { avatarFileId: reference }
    },
    async resolve(references: string[]) {
      const urls: Record<string, string> = {},
        unavailable: string[] = []
      for (const reference of new Set(references)) {
        const key = avatarKey(reference)
        try {
          await readFile(path(key))
        } catch {
          unavailable.push(reference)
          continue
        }
        const expires = now() + 3600000
        urls[reference] =
          `${config.publicUrl}/avatars/content/${key}?expires=${expires}&signature=${signature(key, expires)}`
      }
      return { urls, unavailable }
    },
    async content(key: string, expires: number, signed: string) {
      path(key)
      if (
        !Number.isSafeInteger(expires) ||
        expires <= now() ||
        expires > now() + 3600000 ||
        !/^[a-f0-9]{64}$/.test(signed) ||
        !timingSafeEqual(Buffer.from(signed, 'hex'), Buffer.from(signature(key, expires), 'hex'))
      )
        throw new AppError('FORBIDDEN', '头像链接已失效')
      const bytes = await readFile(path(key))
      validateAvatarContent(bytes)
      return {
        bytes,
        contentType:
          bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp',
      }
    },
  }
}
