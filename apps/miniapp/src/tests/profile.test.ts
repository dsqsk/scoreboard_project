import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProfileStore } from '../features/profile/store'
import type { ProfilePending } from '../features/profile/store'
import { RoomApiError } from '../modules/room-api/errors'
import { createMockRoomApi } from '../modules/room-api/mock'
import { personAvatarSource } from '../features/profile/avatar-source'
import type { Me } from '../modules/room-api/types'
import { createAppStores } from '../stores/create-stores'
function setup() {
  let pending: ProfilePending | null = null
  let uploads = 0
  let lost = false
  let uploadFail = false
  let me: Me = {
    userId: 'user-one',
    displayName: '微信用户',
    avatarFileId: '',
    profileCompleted: false,
  }
  const sent: { requestId: string; displayName: string; avatarFileId?: string }[] = []
  const ports = {
    makeId: () => 'profile-original',
    read: () => pending,
    write(_id: string, value: ProfilePending | null) {
      pending = value
    },
    async upload() {
      uploads++
      if (uploadFail) throw new Error('上传失败')
      return 'cloud://env/avatars/user-one/test.png'
    },
    async update(input: { displayName: string; avatarFileId?: string }, requestId: string) {
      sent.push({ requestId, ...input })
      me = { ...me, ...input, profileCompleted: true }
      if (lost) {
        lost = false
        throw new RoomApiError('TRANSPORT_UNKNOWN', '连接中断')
      }
    },
    async reload() {
      return me
    },
  }
  const profile = createProfileStore(ports)
  profile.open(me)
  return {
    profile,
    ports,
    sent,
    get uploads() {
      return uploads
    },
    lose() {
      lost = true
    },
    failUpload(value: boolean) {
      uploadFail = value
    },
  }
}
test('profile validates name and avatar; upload failure preserves nickname; temporary paths never reach save', async () => {
  const s = setup()
  s.profile.name('  ')
  s.profile.choose('/tmp/avatar.png')
  assert.equal(await s.profile.save(), false)
  assert.equal(s.uploads, 0)
  s.profile.name('  小林  ')
  s.failUpload(true)
  assert.equal(await s.profile.save(), false)
  assert.equal(s.profile.store.getState().name, '  小林  ')
  assert.equal(s.sent.length, 0)
  s.failUpload(false)
  assert.equal(await s.profile.save(), true)
  assert.equal(s.sent[0]!.displayName, '小林')
  assert.ok(s.sent[0]!.avatarFileId!.startsWith('cloud://'))
})
test('unknown profile saves recover original ID and payload after restart without uploading again', async () => {
  const s = setup()
  s.profile.name('小周')
  s.profile.choose('/tmp/avatar.png')
  s.lose()
  assert.equal(await s.profile.save(), false)
  assert.equal(s.profile.store.getState().phase, 'unknown')
  const restored = createProfileStore(s.ports)
  restored.open({ userId: 'user-one', displayName: '微信用户', profileCompleted: false })
  restored.name('不能改原请求')
  restored.choose('/tmp/different.png')
  assert.equal(await restored.save(), true)
  assert.equal(s.uploads, 1)
  assert.deepEqual(s.sent[0], s.sent[1])
})
test('mock defaults persist and allow direct room creation; nickname-only edits preserve avatar', async () => {
  let data: unknown
  const storage = {
    read: () => data,
    write(value: unknown) {
      data = structuredClone(value)
    },
  }
  const api = createMockRoomApi({ storage, delayMs: 0 })
  const stores = createAppStores(api, () => 'profile-room-create')
  const first = await api.getMe()
  assert.equal(first.profileCompleted, true)
  assert.ok(first.defaultAvatar)
  assert.deepEqual(await createMockRoomApi({ storage, delayMs: 0 }).getMe(), first)
  assert.ok(await stores.submit('create', 'point_ball'))
  await api.updateProfile!({ displayName: '仅改名字' }, 'nickname-only')
  assert.deepEqual((await api.getMe()).defaultAvatar, first.defaultAvatar)
  await api.updateProfile!(
    { displayName: '  新朋友 ', avatarFileId: 'cloud://mock/avatars/mock-me/test.png' },
    'profile-request',
  )
  await stores.refreshIdentity()
  assert.ok(await stores.submit('create', 'point_ball'))
  assert.equal((await createMockRoomApi({ storage, delayMs: 0 }).getMe()).displayName, '新朋友')
})

test('SVG avatar uses shared template and validates RGB before interpolation', () => {
  const source = personAvatarSource({ template: 'person-v1', color: '#0C2021' })
  const svg = Buffer.from(source.split(',')[1]!, 'base64').toString()
  assert.ok(svg.includes('stroke="#0C2021"'))
  assert.ok(svg.includes('<circle'))
  const fallback = Buffer.from(
    personAvatarSource({ template: 'person-v1', color: '"/><script>bad</script>' }).split(',')[1]!,
    'base64',
  ).toString()
  assert.ok(!fallback.includes('<script>'))
})

test('default-avatar nickname-only save never uploads a file', async () => {
  const s = setup()
  const profile = createProfileStore(s.ports)
  profile.open({
    userId: 'user-one',
    displayName: '开心的狗',
    defaultAvatar: { template: 'person-v1', color: '#88AA99' },
    profileCompleted: true,
  })
  profile.name('困倦的龙')
  assert.equal(await profile.save(), true)
  assert.equal(s.uploads, 0)
  assert.equal(s.sent[0]!.avatarFileId, undefined)
})
