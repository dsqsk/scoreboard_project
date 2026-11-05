import { AppError } from '../infrastructure/errors'

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

export function validateAvatarReference(
  fileId: string,
  userId: string,
  environmentId: string | undefined,
): void {
  if (!environmentId) throw new AppError('INTERNAL_ERROR', '头像存储环境尚未配置')
  const match =
    /^cloud:\/\/([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\/avatars\/(usr_[a-f0-9]{64})\/([a-zA-Z0-9_-]{8,100})\.(jpg|jpeg|png|webp)$/.exec(
      fileId,
    )
  if (!match || match[1] !== environmentId || match[3] !== userId)
    throw new AppError('INVALID_ARGUMENT', '请上传本人选择的头像')
}

export function validateAvatarContent(content: Buffer): void {
  if (content.length === 0 || content.length > MAX_AVATAR_BYTES)
    throw new AppError('INVALID_ARGUMENT', '头像大小不能超过2MB')
  const jpeg =
    content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
  const png =
    content.length >= 8 &&
    content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const webp =
    content.length >= 12 &&
    content.toString('ascii', 0, 4) === 'RIFF' &&
    content.toString('ascii', 8, 12) === 'WEBP'
  if (!jpeg && !png && !webp) throw new AppError('INVALID_ARGUMENT', '头像仅支持JPG、PNG或WebP图片')
}
