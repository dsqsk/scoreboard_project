import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpApplication } from '../src/http/application'
import { createSessionService } from '../src/http/auth'
import { createAvatarService } from '../src/http/avatars'
import { createMysqlStore, type SqlPool } from '../src/repositories/mysql-store'
import { MemoryStore } from './memory-store'
import { stableId } from '../src/infrastructure/ids'
import { foundationRequestSchema } from '@scoreboard/shared'

function sessionFixture() {
  const sessions = new Map<
    string,
    { app_id: string; open_id: string; expires_at: number; revoked: boolean }
  >()
  const pool: SqlPool = {
    end: async () => {},
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release() {},
      async execute(sql, values = []) {
        if (sql.startsWith('INSERT INTO sb_sessions'))
          sessions.set(String(values[0]), {
            app_id: String(values[1]),
            open_id: String(values[2]),
            expires_at: Number(values[3]),
            revoked: false,
          })
        if (sql.startsWith('UPDATE sb_sessions')) {
          const row = sessions.get(String(values[0]))
          if (row) row.revoked = true
        }
        if (sql.startsWith('SELECT app_id'))
          return [[sessions.get(String(values[0]))].filter(Boolean), {}]
        if (sql.startsWith('SELECT count_value')) return [[{ count_value: 1 }], {}]
        return [[], {}]
      },
    }),
  }
  let clock = 1000
  return {
    service: createSessionService(
      pool,
      { appId: 'wx-test', appSecret: 'server-only' },
      async () => ({ appId: 'wx-test', openId: 'A' }),
      () => clock,
    ),
    sessions,
    expire: () => {
      clock += 8 * 86400000
    },
  }
}

test('HTTP会话使用服务端可信身份、只保存token哈希，可撤销/过期且拒绝伪造Bearer', async () => {
  const f = sessionFixture(),
    s = await f.service.login('valid_code', 'test-address')
  await f.service.save(s.token, s.expiresAt, s.caller)
  assert.equal(f.sessions.has(s.token), false)
  assert.deepEqual(await f.service.authenticate(`Bearer ${s.token}`), {
    appId: 'wx-test',
    openId: 'A',
  })
  await assert.rejects(f.service.authenticate('Bearer forged'))
  await f.service.revoke(`Bearer ${s.token}`)
  await assert.rejects(f.service.authenticate(`Bearer ${s.token}`))
  const second = await f.service.login('new_code', 'test-address')
  await f.service.save(second.token, second.expiresAt, second.caller)
  f.expire()
  await assert.rejects(f.service.authenticate(`Bearer ${second.token}`))
})

test('HTTP health/ready/维护/鉴权及原API信封兼容，非法资料不能绕过新旧头像边界', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scoreboard-http-'))
  try {
    const memory = new MemoryStore(),
      sessions = sessionFixture().service
    let ready = false,
      maintenance = false,
      readyCalls = 0
    const app = createHttpApplication({
      store: { transaction: (op) => memory.transaction(op), request: (op) => op() },
      sessions,
      avatars: createAvatarService({
        directory,
        publicUrl: 'https://example.test',
        signingKey: 'x'.repeat(32),
      }),
      ready: async () => {
        readyCalls++
        return ready
      },
      maintenance: () => maintenance,
    })
    const call = (path: string, body: unknown = {}, authorization?: string, method = 'POST') =>
      app({ method, path, body: Buffer.from(JSON.stringify(body)), address: 'test', authorization })
    assert.equal((await call('/healthz', {}, undefined, 'GET')).status, 200)
    assert.equal((await call('/readyz', {}, undefined, 'GET')).status, 503)
    assert.equal(readyCalls, 1)
    maintenance = true
    assert.equal((await call('/api')).status, 503)
    maintenance = false
    ready = true
    assert.equal((await call('/api')).status, 401)
    const session = await sessions.login('code', 'test')
    await sessions.save(session.token, session.expiresAt, session.caller)
    const token = `Bearer ${session.token}`
    const me = await call('/api', { action: 'identity.getMe', payload: {} }, token)
    assert.equal(me.status, 200)
    const identity = me.body as { ok: boolean; data: { userId: string } }
    assert.equal(identity.data.userId, stableId('usr', 'wx-test', 'A'))
    const forged = await call(
      '/api',
      { action: 'identity.getMe', payload: { userId: 'forged' } },
      token,
    )
    assert.equal((forged.body as { ok: boolean }).ok, false)
    assert.equal(
      foundationRequestSchema.safeParse({
        action: 'identity.updateProfile',
        requestId: 'profile_local',
        payload: {
          displayName: 'Local',
          avatarFileId: `avatar:v1:${identity.data.userId}:${'a'.repeat(32)}.png`,
        },
      }).success,
      true,
    )
    assert.equal(
      foundationRequestSchema.safeParse({
        action: 'identity.updateProfile',
        requestId: 'profile_local',
        payload: { displayName: 'Local', avatarFileId: 'https://external.test/image' },
      }).success,
      false,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('本地头像上传校验所有权，旧云引用缺失不删除，签名过期/篡改拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scoreboard-avatar-'))
  let clock = 1000
  try {
    const service = createAvatarService(
      { directory, publicUrl: 'https://example.test', signingKey: 'x'.repeat(32) },
      () => clock,
    )
    const user = stableId('usr', 'wx-test', 'A'),
      png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const { avatarFileId } = await service.upload(user, 'image/png', png)
    service.validateReference(avatarFileId, user)
    assert.throws(() => service.validateReference(avatarFileId, stableId('usr', 'wx-test', 'B')))
    await service.validate(avatarFileId)
    const legacy = 'cloud://old.env/avatars/legacy.png',
      resolved = await service.resolve([avatarFileId, legacy])
    assert.deepEqual(resolved.unavailable, [legacy])
    const url = new URL(resolved.urls[avatarFileId]),
      key = url.pathname.split('/').at(-1)!,
      expires = Number(url.searchParams.get('expires')),
      signature = url.searchParams.get('signature')!
    assert.deepEqual((await service.content(key, expires, signature)).bytes, png)
    await assert.rejects(service.content(key, expires, '0'.repeat(64)))
    clock = expires
    await assert.rejects(service.content(key, expires, signature))
    await assert.rejects(service.upload(user, 'image/png', Buffer.from('not image')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('MySQL请求共享事务并批量提交；原异常/未知commit失败不成功返回或重试', async () => {
  let commits = 0,
    rollbacks = 0,
    connections = 0
  const sqls: string[] = []
  let commitError: Error | null = null
  const pool: SqlPool = {
    end: async () => {},
    getConnection: async () => {
      connections++
      return {
        beginTransaction: async () => {},
        commit: async () => {
          commits++
          if (commitError) throw commitError
        },
        rollback: async () => {
          rollbacks++
        },
        release() {},
        execute: async (sql) => {
          sqls.push(sql)
          return [[], {}]
        },
      }
    },
  }
  const store = createMysqlStore(pool)
  await store.request(async () => {
    await store.transaction((tx) =>
      tx.set('rate_limits', {
        _id: 'rate_test',
        schemaVersion: 1,
        revision: 0,
        createdAt: 0,
        updatedAt: 0,
        count: 1,
        windowStart: 0,
        requestKeys: [],
      }),
    )
    await store.transaction(async (tx) => {
      assert.equal((await tx.get('rate_limits', 'rate_test'))?.count, 1)
    })
  })
  assert.equal(connections, 1)
  assert.equal(commits, 1)
  assert.equal(sqls.filter((s) => s.startsWith('INSERT')).length, 1)
  assert.equal(
    sqls.some((s) => s.startsWith('SELECT')),
    false,
  )
  const error = new Error('rollback')
  await assert.rejects(
    store.request(async () => {
      throw error
    }),
    (e) => e === error,
  )
  assert.equal(rollbacks, 1)
  commitError = new Error('unknown commit')
  await assert.rejects(
    store.request(async () => 42),
    (e) => e === commitError,
  )
  assert.equal(connections, 3)
  assert.equal(rollbacks, 2)
})
