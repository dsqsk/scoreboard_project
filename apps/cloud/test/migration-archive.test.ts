import test from 'node:test'
import assert from 'node:assert/strict'
import { COLLECTIONS } from '../src/repositories/mysql-schema'
import { archiveDigest, validateArchive, type Archive } from '../src/migration/archive'
import { createApi } from '../src/services/api'
import { MemoryStore } from './memory-store'
import type { CommandReceipt, IdentityDTO, FoundationRoomSnapshot } from '@scoreboard/shared'

async function fixture() {
  const store = new MemoryStore()
  const call = async <T>(
    who: string,
    action: string,
    payload: object,
    requestId?: string,
  ): Promise<T> => {
    const result = await createApi({ store }, () => ({ appId: 'migration-test', openId: who }))({
      action,
      payload,
      ...(requestId ? { requestId } : {}),
    })
    if (!result.ok) assert.fail(result.error.code)
    return result.data as T
  }
  const a = await call<IdentityDTO>('A', 'identity.getMe', {}),
    b = await call<IdentityDTO>('B', 'identity.getMe', {})
  const room = await call<CommandReceipt>(
    'A',
    'room.create',
    { mode: 'point_ball' },
    'migration_create',
  )
  await call('B', 'room.join', { joinCode: room.joinCode }, 'migration_join')
  const snapshot = await call<FoundationRoomSnapshot>('A', 'room.getSnapshot', {
    roomId: room.roomId,
  })
  await call(
    'A',
    'activity.prepare',
    {
      roomId: room.roomId,
      expectedRoomRevision: snapshot.roomRevision,
      participantIds: [a.userId, b.userId],
    },
    'migration_prepare',
  )
  const archive: Archive = {
    schemaVersion: 1,
    environmentId: 'test',
    exportedAt: 0,
    consistentSnapshot: false,
    collections: Object.fromEntries(
      COLLECTIONS.map((name) => [name, store.documents(name)]),
    ) as Archive['collections'],
  }
  return archive
}

test('17集合归档保留全部ID/回执/默认头像，摘要与输入顺序无关', async () => {
  const archive = await fixture()
  assert.equal(validateArchive(archive), archive)
  const hash = archiveDigest(archive),
    copy = structuredClone(archive)
  for (const name of COLLECTIONS) copy.collections[name].reverse()
  assert.equal(archiveDigest(copy), hash)
  assert.deepEqual(
    copy.collections.users.map((user) => JSON.stringify(user.defaultAvatar)).sort(),
    archive.collections.users.map((user) => JSON.stringify(user.defaultAvatar)).sort(),
  )
})

test('归档校验阻断缺失/重复牌、非法身份引用、重复ID、整数溢出、收据改ID与错误积分', async () => {
  const source = await fixture()
  const mutations: ((a: Archive) => void)[] = [
    (a) => {
      a.collections.activity_cards.pop()
    },
    (a) => {
      a.collections.activity_cards[0].number = 2
    },
    (a) => {
      a.collections.room_members[0].userId = 'missing'
    },
    (a) => {
      a.collections.users.push(a.collections.users[0])
    },
    (a) => {
      a.collections.rooms[0].revision = Number.MAX_SAFE_INTEGER + 1
    },
    (a) => {
      a.collections.commands[0].result.requestId = 'tampered'
    },
    (a) => {
      a.collections.activity_scores[0].earnedPoints = 99
    },
    (a) => {
      a.collections.users[0]._id = 'tampered'
    },
  ]
  for (const mutate of mutations) {
    const archive = structuredClone(source)
    mutate(archive)
    assert.throws(() => validateArchive(archive))
  }
})
