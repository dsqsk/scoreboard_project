import type { IdentityDTO } from '@scoreboard/shared'
import type { Caller, User } from '../domain/models'
import type { Store } from '../repositories/store'
import { AppError } from '../infrastructure/errors'
import { meta, stableId } from '../infrastructure/ids'
import { createDefaultProfile, validDefaultAvatar } from './default-profile'

export function validateCaller(caller: Caller): void {
  if (!caller?.appId || !caller?.openId) throw new AppError('UNAUTHENTICATED', '请从微信小程序访问')
}
export const publicUser = (user: User): IdentityDTO => ({
  userId: user._id,
  displayName: user.displayName,
  avatarFileId: user.avatarFileId,
  ...(validDefaultAvatar(user.defaultAvatar) ? { defaultAvatar: user.defaultAvatar } : {}),
  profileCompleted:
    !!user.displayName.trim() && (!!user.avatarFileId || validDefaultAvatar(user.defaultAvatar)),
})
export async function resolveCaller(store: Store, caller: Caller, now: number): Promise<User> {
  validateCaller(caller)
  const id = stableId('usr', caller.appId, caller.openId)
  // Generate only when needed; cache across transaction retries. Persisted values always win.
  let defaults: ReturnType<typeof createDefaultProfile> | undefined
  const fallback = () => (defaults ??= createDefaultProfile())
  return store.transaction(async (tx) => {
    const user = await tx.get('users', id)
    if (user) {
      if (user.status !== 'active') throw new AppError('FORBIDDEN', '当前用户不可用')
      const needsName =
        !user.displayName.trim() ||
        (user.displayName === '微信用户' && user.profileCompletedAt == null)
      if (needsName || !validDefaultAvatar(user.defaultAvatar) || user.profileCompletedAt == null) {
        const completed: User = {
          ...user,
          displayName: needsName ? fallback().displayName : user.displayName,
          defaultAvatar: validDefaultAvatar(user.defaultAvatar)
            ? user.defaultAvatar
            : fallback().defaultAvatar,
          profileCompletedAt: user.profileCompletedAt ?? now,
          updatedAt: now,
          revision: user.revision + 1,
        }
        await tx.set('users', completed)
        return completed
      }
      return user
    }
    const created: User = {
      ...meta(id, now),
      wechatAppId: caller.appId,
      wechatOpenId: caller.openId,
      displayName: fallback().displayName,
      defaultAvatar: fallback().defaultAvatar,
      avatarFileId: null,
      status: 'active',
      profileCompletedAt: now,
    }
    await tx.set('users', created)
    return created
  })
}
