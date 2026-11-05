import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  ApiResult,
  CommandReceipt,
  FoundationResponse,
  FoundationRoomPreview,
  FoundationRoomSnapshot,
  GameMode,
  IdentityDTO,
  MemberPage,
} from '@scoreboard/shared'
import { createApi } from '../src/services/api'
import { stableId } from '../src/infrastructure/ids'
import { MemoryStore } from './memory-store'

function fixture() {
  const store = new MemoryStore()
  let now = Date.UTC(2026, 9, 21)
  let sequence = 0
  const call = (openId: string, event: unknown, appId = 'wx-test') =>
    createApi(
      {
        store,
        now: () => now,
        joinCode: () => String(100000 + ++sequence),
        id: (kind) => `${kind}_${++sequence}`,
      },
      () => ({ openId, appId }),
    )(event)
  const query = <T extends FoundationResponse>(who: string, action: string, payload: object = {}) =>
    call(who, { action, payload }).then((result) => unwrap<T>(result))
  const command = <T extends FoundationResponse = CommandReceipt>(
    who: string,
    action: string,
    payload: object,
    requestId = `request_${++sequence}`,
  ) => call(who, { action, payload, requestId }).then((result) => unwrap<T>(result))
  const me = (who: string) => query<IdentityDTO>(who, 'identity.getMe')
  const create = (mode: GameMode, who = 'A', requestId?: string) =>
    command<CommandReceipt>(who, 'room.create', { mode }, requestId)
  const join = (who: string, code: string) => command(who, 'room.join', { joinCode: code })
  const snapshot = (roomId: string, who = 'A') =>
    query<FoundationRoomSnapshot>(who, 'room.getSnapshot', { roomId })
  const setup = async (mode: GameMode, count: number) => {
    const created = await create(mode)
    const names = ['A', 'B', 'C', 'D', 'E'].slice(0, count)
    for (const name of names.slice(1)) await join(name, created.joinCode!)
    const ids = await Promise.all(names.map((name) => me(name).then((user) => user.userId)))
    const room = await snapshot(created.roomId!)
    return { created, ids, room }
  }
  return {
    store,
    call,
    query,
    command,
    me,
    create,
    join,
    snapshot,
    setup,
    advance: (ms: number) => {
      now += ms
    },
  }
}
function unwrap<T extends FoundationResponse>(response: ApiResult<FoundationResponse>): T {
  if (!response.ok) assert.fail(JSON.stringify(response.error))
  return response.data as T
}
function errorCode(response: ApiResult<FoundationResponse>) {
  assert.equal(response.ok, false)
  if (response.ok) throw new Error('expected error')
  return response.error.code
}

test('可信身份稳定且按AppID隔离，返回资料不包含openid', async () => {
  const f = fixture()
  const [a, b] = await Promise.all([f.me('A'), f.me('A')])
  assert.equal(a.userId, b.userId)
  assert.equal(f.store.documents('users').length, 1)
  assert.equal(Object.hasOwn(a, 'wechatOpenId'), false)
  const otherApp = unwrap<IdentityDTO>(
    await f.call('A', { action: 'identity.getMe', payload: {} }, 'wx-other'),
  )
  assert.notEqual(a.userId, otherApp.userId)
  assert.equal(
    errorCode(await f.call('', { action: 'identity.getMe', payload: {} })),
    'UNAUTHENTICATED',
  )
})

test('微信注入userInfo和tcbContext不参与业务校验或身份，其他未知字段仍拒绝', async () => {
  const f = fixture()
  const expected = await f.me('A')
  const result = unwrap<IdentityDTO>(
    await f.call('A', {
      action: 'identity.getMe',
      payload: {},
      userInfo: { openId: 'forged', appId: 'forged' },
      tcbContext: { openId: 'forged', appId: 'forged' },
    }),
  )
  assert.equal(result.userId, expected.userId)
  assert.equal(
    errorCode(
      await f.call('A', { action: 'identity.getMe', payload: {}, userInfo: {}, openId: 'forged' }),
    ),
    'INVALID_ARGUMENT',
  )
})

test('严格schema拒绝缺少mode、伪造身份、重复参与者与未知动作', async () => {
  const f = fixture()
  for (const event of [
    { action: 'room.create', requestId: 'request_invalid', payload: {} },
    { action: 'identity.getMe', payload: { openId: 'someone-else' } },
    {
      action: 'room.create',
      requestId: 'request_invalid',
      openId: 'someone-else',
      payload: { mode: 'kill_ball' },
    },
    {
      action: 'activity.prepare',
      requestId: 'request_invalid',
      payload: { roomId: 'room_x', expectedRoomRevision: 0, participantIds: ['u1', 'u1'] },
    },
    { action: 'anything.delete', payload: {} },
  ])
    assert.equal(errorCode(await f.call('A', event)), 'INVALID_ARGUMENT')
  assert.equal(f.store.documents('rooms').length, 0)
})

test('创建保留模式和成员，重试同请求只创建一房；相同ID不同参数拒绝', async () => {
  const f = fixture()
  const [first, replay] = await Promise.all([
    f.create('kill_ball', 'A', 'create_same'),
    f.create('kill_ball', 'A', 'create_same'),
  ])
  assert.deepEqual(first, replay)
  const room = await f.snapshot(first.roomId!)
  assert.equal(room.selectedMode, 'kill_ball')
  assert.equal(room.memberCount, 1)
  assert.equal(room.activeActivityId, null)
  assert.equal(room.members.length, 1)
  assert.equal(f.store.documents('rooms').length, 1)
  assert.equal(f.store.documents('room_codes').length, 1)
  assert.equal(f.store.documents('commands').length, 1)
  assert.equal(
    errorCode(
      await f.call('A', {
        action: 'room.create',
        requestId: 'create_same',
        payload: { mode: 'da_a' },
      }),
    ),
    'IDEMPOTENCY_MISMATCH',
  )
})

test('房间码碰撞时选择其他码而不覆盖原房间', async () => {
  const f = fixture()
  const old = await f.create('kill_ball')
  let n = 0
  const api = createApi(
    { store: f.store, joinCode: () => (++n === 1 ? old.joinCode! : '999999') },
    () => ({ appId: 'wx-test', openId: 'B' }),
  )
  const next = unwrap<CommandReceipt>(
    await api({
      action: 'room.create',
      requestId: 'collision_create',
      payload: { mode: 'point_ball' },
    }),
  )
  assert.equal(next.joinCode, '999999')
  assert.equal(f.store.documents('rooms').length, 2)
  assert.equal((await f.snapshot(old.roomId!)).selectedMode, 'kill_ball')
})

test('预览只给最少信息；并发重复加入不增加重复成员，最近列表仅本人房间', async () => {
  const f = fixture()
  const room = await f.create('point_ball')
  const preview = await f.query<FoundationRoomPreview>('B', 'room.preview', {
    joinCode: room.joinCode,
  })
  assert.equal(preview.selectedMode, 'point_ball')
  assert.equal(Object.hasOwn(preview, 'members'), false)
  assert.equal(Object.hasOwn(preview, 'scores'), false)
  assert.equal(
    errorCode(await f.call('B', { action: 'room.getSnapshot', payload: { roomId: room.roomId } })),
    'FORBIDDEN',
  )
  await Promise.all([f.join('B', room.joinCode!), f.join('B', room.joinCode!)])
  assert.equal((await f.snapshot(room.roomId!)).memberCount, 2)
  assert.equal(f.store.documents('room_members').length, 2)
  const recent = await f.query<FoundationRoomPreview[]>('B', 'room.listRecent')
  assert.equal(recent.length, 1)
  assert.equal((await f.query<FoundationRoomPreview[]>('C', 'room.listRecent')).length, 0)
})

test('无效/吊销/过期码和关闭房间不可加入，跨App不可预览', async () => {
  const f = fixture()
  const created = await f.create('kill_ball')
  const event = { action: 'room.preview', payload: { joinCode: created.joinCode } }
  assert.equal(errorCode(await f.call('B', event, 'wx-other')), 'NOT_FOUND')
  await f.store.transaction(async (tx) => {
    const code = (await tx.get('room_codes', created.joinCode!))!
    await tx.set('room_codes', { ...code, status: 'revoked' })
  })
  assert.equal(errorCode(await f.call('B', event)), 'NOT_FOUND')
  await f.store.transaction(async (tx) => {
    const code = (await tx.get('room_codes', created.joinCode!))!
    await tx.set('room_codes', { ...code, status: 'active', expiresAt: 1 })
  })
  assert.equal(errorCode(await f.call('B', event)), 'NOT_FOUND')
  await f.store.transaction(async (tx) => {
    const code = (await tx.get('room_codes', created.joinCode!))!
    await tx.set('room_codes', { ...code, expiresAt: null })
    const room = (await tx.get('rooms', created.roomId!))!
    await tx.set('rooms', { ...room, status: 'closed' })
  })
  assert.equal(errorCode(await f.call('B', event)), 'NOT_FOUND')
  assert.equal(f.store.documents('room_members').length, 1)
})

test('成员列表分页不遗漏、不重复；无关用户无权列成员', async () => {
  const f = fixture()
  const { created } = await f.setup('da_a', 5)
  const first = await f.query<MemberPage>('A', 'room.listMembers', {
    roomId: created.roomId,
    limit: 2,
  })
  const second = await f.query<MemberPage>('A', 'room.listMembers', {
    roomId: created.roomId,
    limit: 2,
    cursor: first.nextCursor,
  })
  const third = await f.query<MemberPage>('A', 'room.listMembers', {
    roomId: created.roomId,
    limit: 2,
    cursor: second.nextCursor,
  })
  assert.equal(
    new Set([...first.members, ...second.members, ...third.members].map((m) => m.userId)).size,
    5,
  )
  assert.equal(third.nextCursor, null)
  assert.equal(
    errorCode(
      await f.call('X', { action: 'room.listMembers', payload: { roomId: created.roomId } }),
    ),
    'FORBIDDEN',
  )
})

test('三人打分准备一次性创建15牌和分数；同请求重试恢复原结果', async () => {
  const f = fixture()
  const { created, ids, room } = await f.setup('point_ball', 3)
  const payload = {
    roomId: created.roomId!,
    expectedRoomRevision: room.roomRevision,
    participantIds: ids,
  }
  const first = await f.command('A', 'activity.prepare', payload, 'prepare_point')
  assert.deepEqual(await f.command('A', 'activity.prepare', payload, 'prepare_point'), first)
  const snapshot = await f.snapshot(created.roomId!)
  assert.equal(snapshot.activity?.scoreScale, 1)
  assert.equal(snapshot.activity?.config.mode, 'point_ball')
  assert.equal(snapshot.cards.length, 15)
  assert.deepEqual(
    snapshot.cards.map((card) => card.number),
    Array.from({ length: 15 }, (_, i) => i + 1),
  )
  assert.equal(
    snapshot.scores.every((score) => score.earnedPoints === 0 && score.netUnits === 0),
    true,
  )
  assert.equal(f.store.documents('activities').length, 1)
  assert.equal(f.store.documents('activity_cards').length, 15)
})

test('两用户同时准备同一房间最多成功一次，不能覆盖进行中活动', async () => {
  const f = fixture()
  const { created, ids, room } = await f.setup('kill_ball', 3)
  const payload = {
    roomId: created.roomId,
    expectedRoomRevision: room.roomRevision,
    participantIds: ids,
  }
  const results = await Promise.all(
    ['A', 'B'].map((who, n) =>
      f.call(who, { action: 'activity.prepare', requestId: `prepare_concurrent_${n}`, payload }),
    ),
  )
  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.equal(f.store.documents('activities').length, 1)
  const latest = await f.snapshot(created.roomId!)
  assert.equal(
    errorCode(
      await f.call('A', {
        action: 'activity.prepare',
        requestId: 'overwrite_active',
        payload: { ...payload, expectedRoomRevision: latest.roomRevision },
      }),
    ),
    'CONFLICT',
  )
  assert.equal(latest.activity?.config.mode, 'kill_ball')
  assert.equal(f.store.documents('activity_cards').length, 0, '准备杀球不等于已发牌')
})

test('活动名单固定，晚加入不改变参与者、基准或原成绩', async () => {
  const f = fixture()
  const { created, ids, room } = await f.setup('point_ball', 3)
  await f.command('A', 'activity.prepare', {
    roomId: created.roomId,
    expectedRoomRevision: room.roomRevision,
    participantIds: ids,
  })
  await f.join('D', created.joinCode!)
  const after = await f.snapshot(created.roomId!, 'D')
  assert.deepEqual(after.activity?.participantIds, ids)
  assert.equal(after.isCurrentParticipant, false)
  assert.equal(
    after.activity?.config.mode === 'point_ball' && after.activity.config.baselineUnits,
    40,
  )
  assert.equal(after.scores.length, 3)
})

test('未入房参与者、人数错误、准备不含本人均被拒绝且无半活动', async () => {
  const f = fixture()
  const { created, ids, room } = await f.setup('point_ball', 4)
  const stranger = await f.me('X')
  const common = { roomId: created.roomId, expectedRoomRevision: room.roomRevision }
  assert.equal(
    errorCode(
      await f.call('A', {
        action: 'activity.prepare',
        requestId: 'prepare_stranger',
        payload: { ...common, participantIds: [ids[0], ids[1], stranger.userId] },
      }),
    ),
    'FORBIDDEN',
  )
  assert.equal(
    errorCode(
      await f.call('A', {
        action: 'activity.prepare',
        requestId: 'prepare_bad_count',
        payload: { ...common, participantIds: ids },
      }),
    ),
    'INVALID_ARGUMENT',
  )
  assert.equal(
    errorCode(
      await f.call('A', {
        action: 'activity.prepare',
        requestId: 'prepare_no_self',
        payload: { ...common, participantIds: ids.slice(1) },
      }),
    ),
    'FORBIDDEN',
  )
  assert.equal(f.store.documents('activities').length, 0)
})

test('扑克底分精确转Units并冻结，准备不产生计分或实际发牌', async () => {
  for (const [mode, count] of [
    ['da_a', 5],
    ['dui_jia', 4],
  ] as const) {
    const f = fixture()
    const { created, ids, room } = await f.setup(mode, count)
    await f.command('A', 'activity.prepare', {
      roomId: created.roomId,
      expectedRoomRevision: room.roomRevision,
      participantIds: ids,
      configInput: { baseStake: '0.29' },
    })
    const next = await f.snapshot(created.roomId!)
    assert.equal(next.activity?.scoreScale, 100)
    const config = next.activity!.config
    assert.ok(config.mode === 'da_a' || config.mode === 'dui_jia')
    assert.equal(config.baseStakeUnits, 29)
    assert.equal(f.store.documents('result_slots').length, 1)
    assert.equal(f.store.documents('activity_cards').length, 0)
    assert.equal(
      next.scores.every((score) => score.netUnits === 0),
      true,
    )
  }
})

test('未配置规则和错误底分明确拒绝，不能伪造配置', async () => {
  const f = fixture()
  const { created, ids, room } = await f.setup('kill_ball', 4)
  assert.equal(
    errorCode(
      await f.call('A', {
        action: 'activity.prepare',
        requestId: 'four_kill_missing',
        payload: {
          roomId: created.roomId,
          expectedRoomRevision: room.roomRevision,
          participantIds: ids,
        },
      }),
    ),
    'RULE_NOT_CONFIGURED',
  )
  const poker = fixture()
  const p = await poker.setup('dui_jia', 4)
  for (const baseStake of ['0', '-1', '0.001']) {
    const result = await poker.call('A', {
      action: 'activity.prepare',
      requestId: `invalid_stake_${baseStake.replaceAll('.', '_').replaceAll('-', '_')}`,
      payload: {
        roomId: p.created.roomId,
        expectedRoomRevision: p.room.roomRevision,
        participantIds: p.ids,
        configInput: { baseStake },
      },
    })
    assert.equal(errorCode(result), 'INVALID_ARGUMENT')
  }
  assert.equal(poker.store.documents('activities').length, 0)
})

test('九球配置保留三人大金+20/-10，两人未定快捷项不猜测', async () => {
  for (const count of [2, 3]) {
    const f = fixture()
    const { created, room, ids } = await f.setup('nine_ball', count)
    await f.command('A', 'activity.prepare', {
      roomId: created.roomId,
      expectedRoomRevision: room.roomRevision,
      participantIds: ids,
    })
    const config = (await f.snapshot(created.roomId!)).activity!.config
    assert.equal(config.mode, 'nine_ball')
    if (config.mode !== 'nine_ball') throw new Error('wrong config')
    assert.equal(
      config.shortcuts.find((item) => item.key === 'big_gold')?.positiveUnits,
      count === 3 ? 20 : undefined,
    )
    assert.equal(
      config.shortcuts.find((item) => item.key === 'big_gold')?.negativeUnits,
      count === 3 ? -10 : undefined,
    )
  }
})

test('事务写入故障回滚全部业务，原requestId可恢复成功', async () => {
  const f = fixture()
  f.store.failCollection = 'commands'
  const event = {
    action: 'room.create',
    requestId: 'atomic_create',
    payload: { mode: 'point_ball' },
  }
  assert.equal(errorCode(await f.call('A', event)), 'INTERNAL_ERROR')
  for (const collection of [
    'rooms',
    'room_codes',
    'room_members',
    'user_room_signals',
    'notification_outbox',
    'commands',
  ] as const)
    assert.equal(f.store.documents(collection).length, 0)
  const created = unwrap<CommandReceipt>(await f.call('A', event))
  assert.ok(created.roomId)
  const { ids, room } = await (async () => {
    await f.join('B', created.joinCode!)
    await f.join('C', created.joinCode!)
    return {
      ids: await Promise.all(['A', 'B', 'C'].map((who) => f.me(who).then((m) => m.userId))),
      room: await f.snapshot(created.roomId!),
    }
  })()
  f.store.failCollection = 'activity_cards'
  const prepare = {
    action: 'activity.prepare',
    requestId: 'atomic_prepare',
    payload: {
      roomId: created.roomId,
      expectedRoomRevision: room.roomRevision,
      participantIds: ids,
    },
  }
  assert.equal(errorCode(await f.call('A', prepare)), 'INTERNAL_ERROR')
  assert.equal(f.store.documents('activities').length, 0)
  assert.equal(f.store.documents('activity_scores').length, 0)
  assert.equal((await f.snapshot(created.roomId!)).activeActivityId, null)
  assert.equal((await f.call('A', prepare)).ok, true)
})

test('查询限流持久化失败请求、窗口后恢复；相同成功命令重试不消耗额外额度', async () => {
  const f = fixture()
  const created = await f.create('kill_ball', 'A', 'rate_replay')
  for (let i = 0; i < 12; i++)
    assert.deepEqual(await f.create('kill_ball', 'A', 'rate_replay'), created)
  for (let i = 0; i < 30; i++)
    assert.equal(
      errorCode(await f.call('B', { action: 'room.preview', payload: { joinCode: '000000' } })),
      'NOT_FOUND',
    )
  assert.equal(
    errorCode(
      await f.call('B', { action: 'room.preview', payload: { joinCode: created.joinCode } }),
    ),
    'RATE_LIMITED',
  )
  f.advance(60000)
  assert.equal(
    (await f.call('B', { action: 'room.preview', payload: { joinCode: created.joinCode } })).ok,
    true,
  )
})

test('更新显示资料不改活动历史快照；禁用用户不能读写', async () => {
  const f = fixture()
  const { created, room, ids } = await f.setup('point_ball', 3)
  await f.command('A', 'activity.prepare', {
    roomId: created.roomId,
    expectedRoomRevision: room.roomRevision,
    participantIds: ids,
  })
  const previousName = (await f.me('A')).displayName
  await f.command('A', 'identity.updateProfile', { displayName: '新的名字' })
  assert.equal((await f.me('A')).displayName, '新的名字')
  assert.equal(
    (await f.snapshot(created.roomId!)).activity?.participants[0].displayName,
    previousName,
  )
  await f.store.transaction(async (tx) => {
    const user = (await tx.get('users', stableId('usr', 'wx-test', 'A')))!
    await tx.set('users', { ...user, status: 'disabled' })
  })
  assert.equal(errorCode(await f.call('A', { action: 'identity.getMe', payload: {} })), 'FORBIDDEN')
})

test('选玩法仅成员可执行，旧版本拒绝，进行中不能切换；不产生幽灵活动', async () => {
  const f = fixture()
  const created = await f.create('kill_ball')
  const event = {
    action: 'room.selectMode',
    requestId: 'select_a_mode',
    payload: { roomId: created.roomId, expectedRoomRevision: 0, mode: 'point_ball' },
  }
  assert.equal(errorCode(await f.call('X', event)), 'FORBIDDEN')
  assert.equal((await f.call('A', event)).ok, true)
  assert.equal((await f.snapshot(created.roomId!)).selectedMode, 'point_ball')
  assert.equal(f.store.documents('activities').length, 0)
  assert.equal(
    errorCode(await f.call('A', { ...event, requestId: 'stale_selection' })),
    'STALE_CONTEXT',
  )
  await f.join('B', created.joinCode!)
  await f.join('C', created.joinCode!)
  const room = await f.snapshot(created.roomId!)
  const ids = await Promise.all(['A', 'B', 'C'].map((who) => f.me(who).then((m) => m.userId)))
  await f.command('A', 'activity.prepare', {
    roomId: created.roomId,
    expectedRoomRevision: room.roomRevision,
    participantIds: ids,
  })
  const latest = await f.snapshot(created.roomId!)
  assert.equal(
    errorCode(
      await f.call('A', {
        ...event,
        requestId: 'switch_active_room',
        payload: { ...event.payload, expectedRoomRevision: latest.roomRevision, mode: 'da_a' },
      }),
    ),
    'CONFLICT',
  )
})
