import test from 'node:test'
import assert from 'node:assert/strict'
import type { ApiResult, FoundationResponse, IdentityDTO } from '@scoreboard/shared'
import { createApi } from '../src/services/api'
import { MAX_AVATAR_BYTES, validateAvatarContent } from '../src/services/avatar'
import { AppError } from '../src/infrastructure/errors'
import { MemoryStore } from './memory-store'
import { createDefaultProfile, isDefaultAvatar } from '@scoreboard/shared'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
)
function ok<T>(result: ApiResult<FoundationResponse>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error))
  return result.data as T
}
function error(result: ApiResult<FoundationResponse>) {
  if (result.ok) assert.fail('expected error')
  return result.error.code
}
function fixture() {
  const store = new MemoryStore()
  const files = new Map<string, Buffer>()
  let checks = 0
  const call = (who: string, event: unknown) =>
    createApi(
      {
        store,
        now: () => 1792630000000,
        avatarEnvironmentId: 'env-test',
        validateAvatar: async (fileId) => {
          checks++
          const data = files.get(fileId)
          if (!data) throw new AppError('INVALID_ARGUMENT', '头像无法读取，请重新上传后保存')
          validateAvatarContent(data)
        },
      },
      () => ({ appId: 'wx-test', openId: who }),
    )(event)
  const me = async (who = 'A') =>
    ok<IdentityDTO>(await call(who, { action: 'identity.getMe', payload: {} }))
  const save = (payload: object, requestId = 'profile_update_1', who = 'A') =>
    call(who, { action: 'identity.updateProfile', requestId, payload })
  const avatar = (userId: string, name = 'avatar_picture') =>
    `cloud://env-test.bucket-test/avatars/${userId}/${name}.png`
  return { store, files, me, save, avatar, checks: () => checks }
}

test('首次自动分配资料，可只改昵称；自选头像原ID恢复及清除后回到默认头像', async () => {
  const f = fixture()
  const original = await f.me()
  assert.equal(original.profileCompleted, true)
  assert.match(original.displayName, /^.+的.+$/)
  assert.equal(original.defaultAvatar?.template, 'person-v1')
  assert.match(original.defaultAvatar!.color, /^#[0-9A-F]{6}$/)
  assert.deepEqual(await f.me(), original)
  ok(await f.save({ displayName: '  小苏  ' }, 'profile_name_only'))
  assert.equal((await f.me()).displayName, '小苏')
  assert.equal((await f.me()).profileCompleted, true)
  const file = f.avatar(original.userId)
  f.files.set(file, png)
  const payload = { displayName: '小苏', avatarFileId: file }
  const first = await f.save(payload)
  ok(first)
  const me = await f.me()
  assert.equal(me.profileCompleted, true)
  assert.equal(me.avatarFileId, file)
  const completedAt = f.store.documents('users')[0].profileCompletedAt
  f.files.delete(file)
  assert.deepEqual(await f.save(payload), first)
  assert.equal(f.checks(), 1)
  assert.equal(error(await f.save({ ...payload, displayName: '换名字' })), 'IDEMPOTENCY_MISMATCH')
  ok(await f.save({ displayName: '换名字' }, 'profile_rename_only'))
  assert.equal((await f.me()).avatarFileId, file)
  assert.equal(f.store.documents('users')[0].profileCompletedAt, completedAt)
  ok(await f.save({ displayName: '换名字', avatarFileId: null }, 'profile_clear_avatar'))
  assert.equal((await f.me()).profileCompleted, true)
  assert.deepEqual((await f.me()).defaultAvatar, original.defaultAvatar)
})

test('拒绝临时头像、外链、跨环境和其他人的头像；校验失败不保存姓名或完成状态', async () => {
  const f = fixture()
  const a = await f.me()
  const b = await f.me('B')
  const own = f.avatar(a.userId)
  const invalid = [
    'wxfile://temp.png',
    'https://example.com/avatar.png',
    f.avatar(b.userId),
    own.replace('env-test.', 'other-env.'),
    own.replace('/avatars/', '/uploads/'),
    own.replace('.png', '.svg'),
  ]
  for (let i = 0; i < invalid.length; i++) {
    assert.equal(
      error(
        await f.save({ displayName: '不应保存', avatarFileId: invalid[i] }, `profile_bad_${i}`),
      ),
      'INVALID_ARGUMENT',
    )
  }
  assert.equal(
    error(await f.save({ displayName: '不应保存', avatarFileId: own })),
    'INVALID_ARGUMENT',
  )
  assert.equal((await f.me()).displayName, a.displayName)
  assert.equal((await f.me()).profileCompleted, true)
  for (const displayName of ['', '   ', '长'.repeat(33)])
    assert.equal(error(await f.save({ displayName })), 'INVALID_ARGUMENT')
  f.files.set(own, png)
  f.store.failCollection = 'commands'
  assert.equal(error(await f.save({ displayName: '小苏', avatarFileId: own })), 'INTERNAL_ERROR')
  assert.equal((await f.me()).profileCompleted, true)
  ok(await f.save({ displayName: '小苏', avatarFileId: own }))
  assert.equal((await f.me()).profileCompleted, true)
})

test('老用户保留自选资料，默认名和缺失头像自动补齐且不重复随机', async () => {
  const f = fixture()
  await f.me()
  const user = f.store.documents('users')[0]
  const { profileCompletedAt: _old, defaultAvatar: _default, ...legacy } = user
  await f.store.transaction((tx) =>
    tx.set('users', { ...legacy, displayName: '老朋友', avatarFileId: f.avatar(user._id) }),
  )
  const custom = await f.me()
  assert.equal(custom.profileCompleted, true)
  assert.equal(custom.displayName, '老朋友')
  assert.equal(custom.avatarFileId, f.avatar(user._id))
  await f.store.transaction((tx) =>
    tx.set('users', {
      ...legacy,
      profileCompletedAt: null,
      displayName: '微信用户',
      avatarFileId: null,
    }),
  )
  const repaired = await f.me()
  assert.equal(repaired.profileCompleted, true)
  assert.notEqual(repaired.displayName, '微信用户')
  assert.ok(repaired.defaultAvatar)
  assert.deepEqual(await f.me(), repaired)
})

test('头像大小与图片头校验拒绝空文件、超限和非图片', () => {
  validateAvatarContent(png)
  validateAvatarContent(Buffer.from([255, 216, 255, 0]))
  validateAvatarContent(Buffer.from('RIFF0000WEBP', 'ascii'))
  for (const file of [
    Buffer.alloc(0),
    Buffer.alloc(MAX_AVATAR_BYTES + 1),
    Buffer.from('<svg onload="x"/>'),
  ])
    assert.throws(() => validateAvatarContent(file), AppError)
})

test('默认资料并发首次识别只保存一份，客户端不能写defaultAvatar或完成状态', async () => {
  const f = fixture()
  const [first, replay] = await Promise.all([f.me(), f.me()])
  assert.deepEqual(first, replay)
  assert.equal(f.store.documents('users').length, 1)
  const color = first.defaultAvatar!.color
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
  const brightness = r * 0.2126 + g * 0.7152 + b * 0.0722
  assert.ok(brightness >= 110 && brightness <= 200)
  assert.equal(
    error(
      await f.save({
        displayName: '自选',
        defaultAvatar: { template: 'person-v1', color: '#000000' },
      }),
    ),
    'INVALID_ARGUMENT',
  )
  assert.equal(
    error(await f.save({ displayName: '自选', profileCompleted: false })),
    'INVALID_ARGUMENT',
  )
  assert.deepEqual(await f.me(), first)
  const other = await f.me('B')
  assert.notEqual(other.userId, first.userId)
  assert.equal(other.profileCompleted, true)
})

test('shared生成器可注入随机源，极端固定值不死循环，SVG描述拒绝非法模板和颜色', () => {
  assert.deepEqual(
    createDefaultProfile(() => 0),
    { displayName: '开心的狗', defaultAvatar: { template: 'person-v1', color: '#72B9A6' } },
  )
  assert.deepEqual(
    createDefaultProfile(() => 0.5),
    createDefaultProfile(() => 0.5),
  )
  assert.ok(isDefaultAvatar(createDefaultProfile(() => 0.5).defaultAvatar))
  for (const value of [
    null,
    {},
    { template: 'other', color: '#112233' },
    { template: 'person-v1', color: 'url(javascript:x)' },
  ])
    assert.equal(isDefaultAvatar(value), false)
  assert.throws(() => createDefaultProfile(() => 1), RangeError)
})
