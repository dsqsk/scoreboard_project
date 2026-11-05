import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  ApiResult,
  FoundationResponse,
  IdentityDTO,
  RecentRoomPage,
  RoomPreview,
  CommandReceipt,
  FoundationRoomSnapshot,
} from '@scoreboard/shared'
import { createApi } from '../src/services/api'
import { meta, stableId } from '../src/infrastructure/ids'
import { MemoryStore } from './memory-store'

function ok<T>(r: ApiResult<FoundationResponse>): T {
  if (!r.ok) assert.fail(JSON.stringify(r.error))
  return r.data as T
}
function code(r: ApiResult<FoundationResponse>) {
  if (r.ok) assert.fail('expected error')
  return r.error.code
}
async function fixture(count = 1, hidden = 0, tied = false) {
  const store = new MemoryStore()
  let sequence = 0
  let now = 1000000
  const call = (
    who: string,
    action: string,
    payload: object,
    requestId?: string,
    appId = 'wx-test',
  ) =>
    createApi({ store, now: () => ++now }, () => ({ openId: who, appId }))({
      action,
      payload,
      ...(requestId ? { requestId } : {}),
    })
  const write = (
    action: string,
    roomId: string,
    requestId = `recent_req_${++sequence}`,
    who = 'A',
  ) => call(who, action, { roomId }, requestId)
  const user = ok<IdentityDTO>(await call('A', 'identity.getMe', {}))
  const ids = Array.from({ length: count }, (_, i) => `room_recent_${i}`)
  await store.transaction(async (tx) => {
    for (let i = 0; i < count; i++) {
      const roomId = ids[i]
      await tx.set('rooms', {
        ...meta(roomId, 1),
        displayName: `房间${i}`,
        wechatAppId: 'wx-test',
        selectedMode: 'point_ball',
        activeActivityId: null,
        createdBy: user.userId,
        status: 'active',
        activeCodeId: String(100000 + i),
        memberCount: 1,
        expiresAt: null,
      })
      await tx.set('room_codes', {
        ...meta(String(100000 + i), 1),
        roomId,
        status: 'active',
        expiresAt: null,
      })
      await tx.set('room_members', {
        ...meta(stableId('mem', roomId, user.userId), 1),
        roomId,
        userId: user.userId,
        status: 'active',
        joinedAt: 1,
        leftAt: null,
        joinSource: 'create',
        lastVisitedAt: tied ? 100 : count - i,
        ...(i < hidden ? { recentHidden: true } : {}),
      })
    }
  })
  const page = async (cursor?: string, limit = 20, who = 'A') =>
    ok<RecentRoomPage>(
      await call(who, 'room.listRecentPage', { ...(cursor ? { cursor } : {}), limit }),
    )
  const member = (roomId: string, userId = user.userId) =>
    store.documents('room_members').find((m) => m.roomId === roomId && m.userId === userId)!
  return { store, call, write, user, ids, page, member }
}

test('隐藏超过20条继续补位，扫描预算空页有后续游标，旧数组接口仍填足20条', async () => {
  const f = await fixture(70, 45)
  const first = await f.page(undefined, 3)
  assert.deepEqual(first.rooms, [])
  assert.ok(first.nextCursor)
  const second = await f.page(first.nextCursor!, 3)
  assert.deepEqual(
    second.rooms.map((r) => r.roomId),
    f.ids.slice(45, 48),
  )
  assert.deepEqual(
    second.rooms.map((r) => r.lastEnteredAt),
    [25, 24, 23],
  )
  const legacy = ok<RoomPreview[]>(await f.call('A', 'room.listRecent', {}))
  assert.deepEqual(
    legacy.map((r) => r.roomId),
    f.ids.slice(45, 65),
  )
  const all: string[] = []
  let cursor: string | undefined
  do {
    const p = await f.page(cursor, 7)
    all.push(...p.rooms.map((r) => r.roomId))
    assert.notEqual(p.nextCursor, cursor)
    cursor = p.nextCursor ?? undefined
  } while (cursor)
  assert.deepEqual(all, f.ids.slice(45))
})

test('同时间按成员ID稳定分页，游标绑定本人，非法与跨用户游标拒绝', async () => {
  const f = await fixture(25, 0, true)
  const expected = f.store
    .documents('room_members')
    .sort((a, b) => a._id.localeCompare(b._id))
    .map((m) => m.roomId)
  let cursor: string | undefined
  const actual: string[] = []
  do {
    const p = await f.page(cursor, 4)
    actual.push(...p.rooms.map((r) => r.roomId))
    if (!cursor)
      assert.equal(
        code(await f.call('B', 'room.listRecentPage', { cursor: p.nextCursor, limit: 4 })),
        'INVALID_ARGUMENT',
      )
    cursor = p.nextCursor ?? undefined
  } while (cursor)
  assert.deepEqual(actual, expected)
  assert.equal(new Set(actual).size, 25)
  for (const payload of [
    { cursor: 'bad_cursor' },
    { limit: 0 },
    { limit: 21 },
    { userId: f.user.userId },
  ])
    assert.equal(code(await f.call('A', 'room.listRecentPage', payload)), 'INVALID_ARGUMENT')
})

test('快照与轮询不恢复隐藏或修改时间，主动enter/join恢复；迟到旧请求不复活条目', async () => {
  const f = await fixture(3)
  const id = f.ids[2]
  const before = structuredClone(f.member(id))
  for (let i = 0; i < 3; i++) ok(await f.call('A', 'room.getSnapshot', { roomId: id }))
  assert.deepEqual(f.member(id), before)
  const enter = await f.write('room.enter', id, 'enter_original')
  ok(enter)
  const enteredAt = f.member(id).lastVisitedAt
  assert.equal((await f.page(undefined, 3)).rooms[0].roomId, id)
  ok(await f.write('room.dismissRecent', id))
  const hiddenMember = structuredClone(f.member(id))
  ok(await f.call('A', 'room.getSnapshot', { roomId: id }))
  assert.deepEqual(await f.write('room.enter', id, 'enter_original'), enter)
  assert.deepEqual(f.member(id), hiddenMember)
  assert.equal(f.member(id).lastVisitedAt, enteredAt)
  assert.ok(!(await f.page()).rooms.some((r) => r.roomId === id))
  const joinRequest = { joinCode: '100002' }
  const joined = await f.call('A', 'room.join', joinRequest, 'join_original')
  ok(joined)
  assert.equal(f.member(id).recentHidden, false)
  ok(await f.write('room.dismissRecent', id))
  assert.deepEqual(await f.call('A', 'room.join', joinRequest, 'join_original'), joined)
  assert.equal(f.member(id).recentHidden, true)
  ok(await f.write('room.enter', id))
  assert.equal(f.member(id).recentHidden, false)
  assert.equal((await f.page()).rooms[0].roomId, id)
  assert.equal(f.store.documents('room_members').length, 3)
})

test('移除仅本人可见性，成员资格和进行中活动/牌/成绩不变，另一成员仍可见', async () => {
  const f = await fixture()
  const id = f.ids[0]
  ok(await f.call('B', 'room.join', { joinCode: '100000' }, 'join_user_b'))
  const b = ok<IdentityDTO>(await f.call('B', 'identity.getMe', {}))
  const snapshot = ok<FoundationRoomSnapshot>(await f.call('A', 'room.getSnapshot', { roomId: id }))
  ok<CommandReceipt>(
    await f.call(
      'A',
      'activity.prepare',
      {
        roomId: id,
        expectedRoomRevision: snapshot.roomRevision,
        participantIds: [f.user.userId, b.userId],
      },
      'prepare_for_recent',
    ),
  )
  const rooms = f.store.documents('rooms')
  const activities = f.store.documents('activities')
  const cards = f.store.documents('activity_cards')
  const scores = f.store.documents('activity_scores')
  const otherMember = f.member(id, b.userId)
  const hidden = await f.write('room.dismissRecent', id, 'dismiss_original')
  ok(hidden)
  assert.deepEqual(await f.write('room.dismissRecent', id, 'dismiss_original'), hidden)
  assert.equal(f.member(id).status, 'active')
  assert.deepEqual(f.member(id, b.userId), otherMember)
  assert.deepEqual(f.store.documents('rooms'), rooms)
  assert.deepEqual(f.store.documents('activities'), activities)
  assert.deepEqual(f.store.documents('activity_cards'), cards)
  assert.deepEqual(f.store.documents('activity_scores'), scores)
  assert.equal((await f.page()).rooms.length, 0)
  assert.equal((await f.page(undefined, 20, 'B')).rooms.length, 1)
  const stillMember = ok<FoundationRoomSnapshot>(
    await f.call('A', 'room.getSnapshot', { roomId: id }),
  )
  assert.equal(stillMember.activeActivityId, activities[0]._id)
  assert.equal(stillMember.members.length, 2)
  const personalBeforeScore = structuredClone(f.member(id))
  ok(
    await f.call(
      'B',
      'point.claim',
      { roomId: id, activityId: activities[0]._id, number: 1, expectedCardRevision: 0 },
      'score_after_dismiss',
    ),
  )
  assert.deepEqual(f.member(id), personalBeforeScore)
  assert.deepEqual(f.member(id, b.userId), otherMember)
  assert.equal((await f.page()).rooms.length, 0)
})

test('移除失败回滚，原ID可恢复；非法身份或异载荷拒绝，重开服务仍隐藏', async () => {
  const f = await fixture(2)
  const id = f.ids[0]
  assert.equal(code(await f.write('room.dismissRecent', id, 'other_dismiss', 'B')), 'FORBIDDEN')
  assert.equal(code(await f.write('room.enter', id, 'other_enter', 'B')), 'FORBIDDEN')
  assert.equal(
    code(await f.call('A', 'room.dismissRecent', { roomId: id, userId: 'other' }, 'fake_identity')),
    'INVALID_ARGUMENT',
  )
  assert.equal(
    code(await f.call('A', 'room.dismissRecent', { roomId: id }, 'cross_app_id', 'wx-other')),
    'FORBIDDEN',
  )
  f.store.failCollection = 'commands'
  const before = structuredClone(f.member(id))
  assert.equal(code(await f.write('room.dismissRecent', id, 'dismiss_failure')), 'INTERNAL_ERROR')
  assert.deepEqual(f.member(id), before)
  ok(await f.write('room.dismissRecent', id, 'dismiss_failure'))
  assert.equal(
    code(await f.write('room.dismissRecent', f.ids[1], 'dismiss_failure')),
    'IDEMPOTENCY_MISMATCH',
  )
  // Each call constructs a fresh service/API instance over persisted storage.
  assert.deepEqual(
    (await f.page()).rooms.map((r) => r.roomId),
    [f.ids[1]],
  )
})

test('关闭/过期/缺失房间不展示，可移除本人旧条目；主动进入仍拒绝', async () => {
  const f = await fixture(4)
  const previousEnter = await f.write('room.enter', f.ids[0], 'enter_before_closed')
  ok(previousEnter)
  await f.store.transaction(async (tx) => {
    const closed = (await tx.get('rooms', f.ids[0]))!
    await tx.set('rooms', { ...closed, status: 'closed' })
    const expired = (await tx.get('rooms', f.ids[1]))!
    await tx.set('rooms', { ...expired, expiresAt: 1 })
    const member = f.member(f.ids[2])
    await tx.set('room_members', {
      ...member,
      roomId: 'missing_room',
      _id: stableId('mem', 'missing_room', f.user.userId),
    })
  })
  assert.deepEqual(
    (await f.page()).rooms.map((r) => r.roomId),
    [f.ids[2], f.ids[3]],
  )
  for (const id of [f.ids[0], f.ids[1], 'missing_room']) {
    ok(await f.write('room.dismissRecent', id))
    assert.equal(f.member(id).recentHidden, true)
    assert.equal(code(await f.write('room.enter', id)), 'NOT_FOUND')
  }
  assert.deepEqual(await f.write('room.enter', f.ids[0], 'enter_before_closed'), previousEnter)
  assert.equal(f.member(f.ids[0]).recentHidden, true)
})
