import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  CommandReceipt,
  IdentityDTO,
  PointSnapshot,
  FoundationResponse,
  ApiResult,
  FoundationRoomSnapshot,
} from '@scoreboard/shared'
import { createApi } from '../src/services/api'
import { MemoryStore } from './memory-store'
import { defaultRules, prepareConfig } from '../src/services/rules'

function unwrap<T>(response: ApiResult<FoundationResponse>): T {
  if (!response.ok) assert.fail(JSON.stringify(response.error))
  return response.data as T
}
function code(response: ApiResult<FoundationResponse>) {
  if (response.ok) assert.fail('expected error')
  return response.error.code
}
async function setup(count: 2 | 3 = 3) {
  const store = new MemoryStore()
  let seq = 0
  const call = (who: string, action: string, payload: object, requestId?: string) =>
    createApi(
      {
        store,
        id: (kind) => `${kind}_${++seq}`,
        joinCode: () => String(100000 + ++seq),
        now: () => 1790000000000 + seq,
      },
      () => ({ appId: 'wx-test', openId: who }),
    )({ action, payload, ...(requestId ? { requestId } : {}) })
  const write = (who: string, action: string, payload: object, requestId = `point_req_${++seq}`) =>
    call(who, action, payload, requestId)
  const ids: string[] = []
  for (const who of ['A', 'B', 'C', 'D'])
    ids.push(unwrap<IdentityDTO>(await call(who, 'identity.getMe', {})).userId)
  const room = unwrap<CommandReceipt>(await write('A', 'room.create', { mode: 'point_ball' }))
  const roomId = room.roomId!
  for (const who of ['B', 'C'].slice(0, count - 1))
    unwrap(await write(who, 'room.join', { joinCode: room.joinCode }))
  const snapshot = unwrap<FoundationRoomSnapshot>(await call('A', 'room.getSnapshot', { roomId }))
  const prepared = unwrap<CommandReceipt>(
    await write('A', 'activity.prepare', {
      roomId,
      expectedRoomRevision: snapshot.roomRevision,
      participantIds: ids.slice(0, count),
    }),
  )
  const activityId = prepared.activityId!
  const state = async (extra: object = {}) =>
    unwrap<PointSnapshot>(await call('A', 'point.getState', { roomId, ...extra }))
  const claim = (who: string, number: number, revision = 0, requestId?: string) =>
    write(
      who,
      'point.claim',
      { roomId, activityId, number, expectedCardRevision: revision },
      requestId,
    )
  const correct = (
    who: string,
    number: number,
    ownerUserId: string | null,
    revision: number,
    requestId?: string,
  ) =>
    write(
      who,
      'point.correct',
      { roomId, activityId, number, expectedCardRevision: revision, ownerUserId },
      requestId,
    )
  const post = async (who = 'A', requestId?: string) =>
    write(
      who,
      'point.post',
      { roomId, activityId, expectedActivityRevision: (await state()).activity!.revision },
      requestId,
    )
  return { store, ids, room, roomId, activityId, state, call, write, claim, correct, post }
}

test('两人底分60，晚加入不改变名单；两人三人混合历史各按自身人数计分', async () => {
  const f = await setup(2)
  let snapshot = unwrap<FoundationRoomSnapshot>(
    await f.call('A', 'room.getSnapshot', { roomId: f.roomId }),
  )
  assert.equal(snapshot.activity!.rulesVersion, 'point-ball-v2')
  assert.equal(
    snapshot.activity!.config.mode === 'point_ball' && snapshot.activity!.config.baselineUnits,
    60,
  )
  unwrap(await f.write('C', 'room.join', { joinCode: f.room.joinCode }))
  assert.equal((await f.state()).activity!.participants.length, 2)
  assert.equal(code(await f.claim('C', 1)), 'FORBIDDEN')
  assert.equal(code(await f.post('C')), 'FORBIDDEN')
  for (let n = 1; n <= 15; n++) unwrap(await f.claim(n <= 10 ? 'A' : 'B', n))
  // 55/65 minus 60 gives -5/+5; original ID retries cannot add a second result.
  const before = await f.state()
  const p = {
    roomId: f.roomId,
    activityId: f.activityId,
    expectedActivityRevision: before.activity!.revision,
  }
  const saved = await f.write('A', 'point.post', p, 'post_two_players')
  unwrap(saved)
  assert.deepEqual(await f.write('A', 'point.post', p, 'post_two_players'), saved)
  const two = await f.state()
  assert.deepEqual(two.totals, { [f.ids[0]]: -5, [f.ids[1]]: 5 })
  assert.equal(two.results[0].participants.length, 2)
  assert.equal(two.results[0].deltas[f.ids[0]], -5)
  const storedResult = f.store.documents('point_results')[0]
  await f.store.transaction((tx) =>
    tx.set('point_results', {
      ...storedResult,
      result: { ...storedResult.result, deltas: { [f.ids[0]]: 15, [f.ids[1]]: 25 } },
    }),
  )
  assert.equal(code(await f.call('A', 'point.getState', { roomId: f.roomId })), 'INTERNAL_ERROR')
  await f.store.transaction((tx) => tx.set('point_results', storedResult))
  unwrap(
    await f.write('A', 'activity.prepare', {
      roomId: f.roomId,
      expectedRoomRevision: two.roomRevision,
      participantIds: f.ids.slice(0, 3),
    }),
  )
  snapshot = unwrap<FoundationRoomSnapshot>(
    await f.call('A', 'room.getSnapshot', { roomId: f.roomId }),
  )
  assert.equal(
    snapshot.activity!.config.mode === 'point_ball' && snapshot.activity!.config.baselineUnits,
    40,
  )
  const nextId = snapshot.activeActivityId!
  // Legacy three-player activities retain their rule snapshot and remain readable/postable.
  await f.store.transaction(async (tx) => {
    const activity = (await tx.get('activities', nextId))!
    await tx.set('activities', { ...activity, rulesVersion: 'foundation-v1' })
  })
  for (let number = 1; number <= 15; number++) {
    const who = [15, 14, 13, 12, 6].includes(number)
      ? 'A'
      : [11, 10, 9, 8, 2].includes(number)
        ? 'B'
        : 'C'
    unwrap(
      await f.write(who, 'point.claim', {
        roomId: f.roomId,
        activityId: nextId,
        number,
        expectedCardRevision: 0,
      }),
    )
  }
  unwrap(
    await f.write('A', 'point.post', {
      roomId: f.roomId,
      activityId: nextId,
      expectedActivityRevision: (await f.state()).activity!.revision,
    }),
  )
  const mixed = await f.state()
  assert.deepEqual(
    mixed.results.map((result) => result.participants.length),
    [3, 2],
  )
  assert.deepEqual(mixed.results[0].deltas, { [f.ids[0]]: 20, [f.ids[1]]: 0, [f.ids[2]]: -20 })
  assert.deepEqual(mixed.results[1].deltas, two.results[0].deltas)
  assert.deepEqual(mixed.totals, { [f.ids[0]]: 15, [f.ids[1]]: 5, [f.ids[2]]: -20 })
  assert.equal(
    f.store.documents('activities').find((activity) => activity._id === nextId)!.rulesVersion,
    'foundation-v1',
  )
})

test('拒绝其他人数与错误活动底分', async () => {
  for (const count of [0, 1, 4, 5])
    assert.throws(() => prepareConfig('point_ball', count, {}, defaultRules))
  const f = await setup(2)
  await f.store.transaction(async (tx) => {
    const activity = (await tx.get('activities', f.activityId))!
    if (activity.config.mode !== 'point_ball') assert.fail('wrong config')
    await tx.set('activities', { ...activity, config: { ...activity.config, baselineUnits: 40 } })
  })
  assert.equal(code(await f.call('A', 'point.getState', { roomId: f.roomId })), 'INTERNAL_ERROR')
})

test('打分认领修正退回与初始记录人保留，过程不计入累计', async () => {
  const f = await setup()
  unwrap(await f.claim('A', 6))
  unwrap(await f.claim('B', 9))
  let s = await f.state()
  assert.deepEqual(s.activity!.earnedPoints, { [f.ids[0]]: 6, [f.ids[1]]: 9, [f.ids[2]]: 0 })
  assert.deepEqual(s.totals, {})
  unwrap(await f.correct('C', 6, f.ids[1], 1))
  unwrap(await f.correct('B', 6, null, 2))
  unwrap(await f.claim('C', 6, 3))
  s = await f.state()
  assert.deepEqual(s.activity!.earnedPoints, { [f.ids[0]]: 0, [f.ids[1]]: 9, [f.ids[2]]: 6 })
  const card = s.activity!.cards[5]
  assert.equal(card.initialRecordedBy, f.ids[0])
  assert.equal(card.lastModifiedBy, f.ids[2])
  assert.equal(card.revision, 4)
  assert.equal(s.activity!.changes.length, 5)
  assert.equal(s.results.length, 0)
})

test('同牌竞争一个成功，不同牌独立成功；原ID幂等和异载荷拒绝', async () => {
  const f = await setup()
  const race = await Promise.all([
    f.claim('A', 6, 0, 'claim_race_a'),
    f.claim('B', 6, 0, 'claim_race_b'),
  ])
  assert.equal(race.filter((r) => r.ok).length, 1)
  assert.equal(code(race.find((r) => !r.ok)!), 'CONFLICT')
  const first = await f.claim('A', 1, 0, 'claim_repeat')
  assert.deepEqual(await f.claim('A', 1, 0, 'claim_repeat'), first)
  assert.equal(code(await f.claim('A', 2, 0, 'claim_repeat')), 'IDEMPOTENCY_MISMATCH')
  const independent = await Promise.all([f.claim('A', 2), f.claim('B', 3)])
  assert.ok(independent.every((r) => r.ok))
  assert.equal((await f.state()).activity!.changes.length, 4)
})

test('晚加入成员可修正不可认领或保存；非法目标、未归属correct和非成员均拒绝', async () => {
  const f = await setup()
  assert.equal(code(await f.call('D', 'point.getState', { roomId: f.roomId })), 'FORBIDDEN')
  unwrap(await f.write('D', 'room.join', { joinCode: f.room.joinCode }))
  assert.equal(code(await f.claim('D', 1)), 'FORBIDDEN')
  assert.equal(code(await f.post('D')), 'FORBIDDEN')
  assert.equal(code(await f.correct('D', 1, f.ids[0], 0)), 'CONFLICT')
  unwrap(await f.claim('A', 1))
  assert.equal(code(await f.correct('D', 1, f.ids[3], 1)), 'INVALID_ARGUMENT')
  unwrap(await f.correct('D', 1, f.ids[1], 1))
  assert.equal((await f.state()).activity!.participants.length, 3)
  assert.equal(code(await f.claim('A', 16)), 'INVALID_ARGUMENT')
})

async function fill(f: Awaited<ReturnType<typeof setup>>) {
  // A: 15+14+13+12+6=60; B: 11+10+9+8+2=40; C: remaining=20.
  for (let number = 1; number <= 15; number++) {
    const who = [15, 14, 13, 12, 6].includes(number)
      ? 'A'
      : [11, 10, 9, 8, 2].includes(number)
        ? 'B'
        : 'C'
    unwrap(await f.claim(who, number))
  }
}

test('完整120分保存60/40/20为+20/0/-20，重复保存不累计，保存后只读和再来一次保留历史', async () => {
  const f = await setup()
  assert.equal(code(await f.post()), 'CONFLICT')
  await fill(f)
  const s = await f.state()
  const payload = {
    roomId: f.roomId,
    activityId: f.activityId,
    expectedActivityRevision: s.activity!.revision,
  }
  const first = await f.write('A', 'point.post', payload, 'post_repeat')
  unwrap(first)
  assert.deepEqual(await f.write('A', 'point.post', payload, 'post_repeat'), first)
  assert.equal(code(await f.post()), 'ALREADY_POSTED')
  assert.equal(code(await f.correct('A', 1, null, 1)), 'ALREADY_POSTED')
  const saved = await f.state()
  assert.deepEqual(saved.totals, { [f.ids[0]]: 20, [f.ids[1]]: 0, [f.ids[2]]: -20 })
  assert.equal(saved.results.length, 1)
  assert.equal(f.store.documents('point_results').length, 1)
  const prepare = {
    roomId: f.roomId,
    expectedRoomRevision: saved.roomRevision,
    participantIds: f.ids.slice(0, 3),
  }
  const next = await Promise.all([
    f.write('A', 'activity.prepare', prepare),
    f.write('B', 'activity.prepare', prepare),
  ])
  assert.equal(next.filter((r) => r.ok).length, 1)
  const fresh = await f.state()
  assert.notEqual(fresh.activity!.activityId, f.activityId)
  assert.ok(fresh.activity!.cards.every((c) => c.ownerUserId === null))
  assert.deepEqual(fresh.totals, saved.totals)
  assert.equal(fresh.results.length, 1)
  assert.deepEqual(await f.write('A', 'point.post', payload, 'post_repeat'), first)
  assert.equal(code(await f.claim('A', 1)), 'STALE_CONTEXT')
})

test('保存版本冲突、先修正或先保存均不出现混合结果；事务失败回滚并可原ID恢复', async () => {
  const f = await setup()
  await fill(f)
  const before = await f.state()
  unwrap(await f.correct('A', 1, f.ids[0], 1))
  assert.equal(
    code(
      await f.write('A', 'point.post', {
        roomId: f.roomId,
        activityId: f.activityId,
        expectedActivityRevision: before.activity!.revision,
      }),
    ),
    'STALE_CONTEXT',
  )
  f.store.failCollection = 'point_totals'
  const p = {
    roomId: f.roomId,
    activityId: f.activityId,
    expectedActivityRevision: (await f.state()).activity!.revision,
  }
  assert.equal(code(await f.write('A', 'point.post', p, 'post_failure')), 'INTERNAL_ERROR')
  assert.equal(f.store.documents('point_results').length, 0)
  assert.equal((await f.state()).activity!.status, 'open')
  assert.ok(f.store.documents('activity_scores').every((score) => score.netUnits === 0))
  unwrap(await f.write('A', 'point.post', p, 'post_failure'))
  assert.equal((await f.state()).activity!.status, 'posted')
  assert.equal(code(await f.correct('A', 1, null, 2)), 'ALREADY_POSTED')
})

test('修改日志分页、游标隔离及失败修改回滚', async () => {
  const f = await setup()
  unwrap(await f.claim('A', 1))
  for (let i = 1; i <= 24; i++) unwrap(await f.correct('A', 1, f.ids[i % 2], i))
  const first = await f.state()
  assert.equal(first.activity!.changes.length, 20)
  assert.ok(first.nextChangeCursor)
  const second = await f.state({ changeCursor: first.nextChangeCursor })
  assert.equal(second.activity!.changes.length, 5)
  assert.equal(second.nextChangeCursor, null)
  assert.equal(
    new Set([...first.activity!.changes, ...second.activity!.changes].map((c) => c.requestId)).size,
    25,
  )
  assert.equal(
    code(await f.call('A', 'point.getState', { roomId: f.roomId, resultCursor: 'invalid_cursor' })),
    'INVALID_ARGUMENT',
  )
  f.store.failCollection = 'point_changes'
  assert.equal(code(await f.correct('A', 1, null, 25, 'correct_failure')), 'INTERNAL_ERROR')
  const after = await f.state()
  assert.deepEqual(after, first)
  unwrap(await f.correct('A', 1, null, 25, 'correct_failure'))
})

test('跨21局历史分页不遗漏，累计独立于历史页，旧活动修改游标不可用于新活动', async () => {
  const f = await setup()
  let oldChangeCursor: string | null = null
  for (let round = 0; round < 21; round++) {
    const open = await f.state()
    const activityId = open.activity!.activityId
    for (let number = 1; number <= 15; number++) {
      const who = [15, 14, 13, 12, 6].includes(number)
        ? 'A'
        : [11, 10, 9, 8, 2].includes(number)
          ? 'B'
          : 'C'
      unwrap(
        await f.write(who, 'point.claim', {
          roomId: f.roomId,
          activityId,
          number,
          expectedCardRevision: 0,
        }),
      )
    }
    if (round === 0) {
      for (let i = 1; i <= 6; i++) unwrap(await f.correct('A', 1, f.ids[i % 2], i))
      // Restore C's 1 so this round also settles 60/40/20.
      unwrap(await f.correct('A', 1, f.ids[2], 7))
      oldChangeCursor = (await f.state()).nextChangeCursor
    }
    const full = await f.state()
    unwrap(
      await f.write('A', 'point.post', {
        roomId: f.roomId,
        activityId,
        expectedActivityRevision: full.activity!.revision,
      }),
    )
    if (round < 20)
      unwrap(
        await f.write('A', 'activity.prepare', {
          roomId: f.roomId,
          expectedRoomRevision: full.roomRevision,
          participantIds: f.ids.slice(0, 3),
        }),
      )
  }
  const first = await f.state()
  assert.equal(first.results.length, 20)
  assert.ok(first.nextResultCursor)
  assert.deepEqual(first.totals, { [f.ids[0]]: 420, [f.ids[1]]: 0, [f.ids[2]]: -420 })
  const second = await f.state({ resultCursor: first.nextResultCursor })
  assert.equal(second.results.length, 1)
  assert.equal(second.nextResultCursor, null)
  assert.deepEqual(second.totals, first.totals)
  assert.equal(new Set([...first.results, ...second.results].map((r) => r.activityId)).size, 21)
  assert.ok(oldChangeCursor)
  assert.equal(
    code(await f.call('A', 'point.getState', { roomId: f.roomId, changeCursor: oldChangeCursor })),
    'STALE_CONTEXT',
  )
})

test('两个快照入口及记分命令共享一次牌查询，不再逐张读牌，乱序数据按号码恢复', async () => {
  const f = await setup()
  const original = f.store.transaction.bind(f.store)
  let queries = 0
  let singleReads = 0
  f.store.transaction = (operation) =>
    original((tx) =>
      operation({
        ...tx,
        async get(collection, id) {
          if (collection === 'activity_cards') singleReads++
          return tx.get(collection, id)
        },
        async listPointCards(activityId) {
          queries++
          return (await tx.listPointCards(activityId)).reverse()
        },
      }),
    )
  const point = await f.state()
  assert.deepEqual(
    point.activity!.cards.map((card) => card.number),
    Array.from({ length: 15 }, (_, i) => i + 1),
  )
  assert.equal(queries, 1)
  const room = unwrap<FoundationRoomSnapshot>(
    await f.call('A', 'room.getSnapshot', { roomId: f.roomId }),
  )
  assert.deepEqual(
    room.cards.map((card) => card.number),
    point.activity!.cards.map((card) => card.number),
  )
  assert.equal(queries, 2)
  unwrap(await f.claim('A', 1))
  assert.equal(queries, 3)
  assert.equal(singleReads, 0)
})

test('批量牌查询拒绝缺失、重复、超额、非法号码/归属/标识，两个快照和写入均保留完整性校验', async () => {
  const f = await setup()
  const original = f.store.transaction.bind(f.store)
  type Card = ReturnType<typeof f.store.documents<'activity_cards'>>[number]
  let corrupt = (cards: Card[]) => cards.slice(1)
  f.store.transaction = (operation) =>
    original((tx) =>
      operation({
        ...tx,
        async listPointCards(activityId) {
          return corrupt(await tx.listPointCards(activityId))
        },
      }),
    )
  const cases: ((cards: Card[]) => Card[])[] = [
    (cards) => cards.slice(1),
    (cards) => [...cards.slice(0, 14), cards[0]],
    (cards) => [...cards, cards[0]],
    (cards) => cards.map((card, i) => (i === 0 ? { ...card, number: 0 } : card)),
    (cards) => cards.map((card, i) => (i === 0 ? { ...card, ownerUserId: 'outsider' } : card)),
    (cards) => cards.map((card, i) => (i === 0 ? { ...card, roomId: 'other' } : card)),
    (cards) => cards.map((card, i) => (i === 0 ? { ...card, activityId: 'other' } : card)),
    (cards) => cards.map((card, i) => (i === 0 ? { ...card, _id: 'wrong' } : card)),
    (cards) => cards.map((card, i) => (i === 0 ? { ...card, points: 99 } : card)),
  ]
  const before = f.store.documents('activity_cards')
  for (const transform of cases) {
    corrupt = transform
    assert.equal(code(await f.call('A', 'point.getState', { roomId: f.roomId })), 'INTERNAL_ERROR')
    assert.equal(
      code(await f.call('A', 'room.getSnapshot', { roomId: f.roomId })),
      'INTERNAL_ERROR',
    )
    assert.equal(code(await f.claim('A', 1)), 'INTERNAL_ERROR')
    assert.deepEqual(f.store.documents('activity_cards'), before)
  }
})

test('稳定ID批量读取忽略非标准ID额外牌，与原15次doc读取范围一致', async () => {
  const f = await setup()
  const card = f.store.documents('activity_cards')[0]
  await f.store.transaction((tx) =>
    tx.set('activity_cards', {
      ...card,
      _id: 'nonstandard_extra_card',
      number: 99,
      points: 99,
    }),
  )
  assert.equal((await f.state()).activity!.cards.length, 15)
  assert.equal(
    unwrap<FoundationRoomSnapshot>(await f.call('A', 'room.getSnapshot', { roomId: f.roomId }))
      .cards.length,
    15,
  )
  unwrap(await f.claim('A', 1))
  assert.equal(
    f.store.documents('activity_cards').find((item) => item._id === 'nonstandard_extra_card')
      ?.ownerUserId,
    null,
  )
})

test('claim/correct事务回执携带完整写后投影，积分和变更与提交绑定，无额外状态/历史读取', async () => {
  const f = await setup()
  const original = f.store.transaction.bind(f.store)
  let transactions = 0
  let cardQueries = 0
  const reads: string[] = []
  f.store.transaction = (operation) => {
    transactions++
    return original((tx) =>
      operation({
        ...tx,
        async get(collection, id) {
          reads.push(collection)
          return tx.get(collection, id)
        },
        async listPointCards(activityId) {
          cardQueries++
          return tx.listPointCards(activityId)
        },
      }),
    )
  }
  const claimed = unwrap<CommandReceipt>(await f.claim('A', 6, 0, 'commit_claim_six'))
  const projection = claimed.pointState!
  assert.equal(transactions, 2) // existing identity transaction + command transaction only
  assert.equal(cardQueries, 1)
  assert.equal(
    reads.some((name) => ['point_results', 'point_changes', 'point_totals'].includes(name)),
    false,
  )
  assert.equal(projection.activityId, claimed.activityId)
  assert.equal(projection.revision, claimed.activityRevision)
  assert.equal(projection.status, 'open')
  assert.equal(projection.cards.length, 15)
  assert.deepEqual(
    projection.cards.map((card) => card.number),
    Array.from({ length: 15 }, (_, i) => i + 1),
  )
  assert.deepEqual(projection.cards[5], {
    number: 6,
    ownerUserId: f.ids[0],
    revision: 1,
    initialRecordedBy: f.ids[0],
    lastModifiedBy: f.ids[0],
  })
  assert.deepEqual(projection.earnedPoints, { [f.ids[0]]: 6, [f.ids[1]]: 0, [f.ids[2]]: 0 })
  assert.equal(projection.change.requestId, claimed.requestId)
  assert.equal(projection.change.number, 6)
  assert.equal(projection.change.fromUserId, null)
  assert.equal(projection.change.toUserId, f.ids[0])
  assert.equal(projection.change.actorUserId, f.ids[0])
  const corrected = unwrap<CommandReceipt>(
    await f.correct('B', 6, f.ids[1], 1, 'commit_correct_six'),
  )
  assert.deepEqual(corrected.pointState!.earnedPoints, {
    [f.ids[0]]: 0,
    [f.ids[1]]: 6,
    [f.ids[2]]: 0,
  })
  assert.equal(corrected.pointState!.cards[5].revision, 2)
  assert.equal(corrected.pointState!.cards[5].initialRecordedBy, f.ids[0])
  assert.equal(corrected.pointState!.cards[5].lastModifiedBy, f.ids[1])
  assert.equal(corrected.pointState!.change.fromUserId, f.ids[0])
  assert.equal(corrected.pointState!.change.toUserId, f.ids[1])
  const cleared = unwrap<CommandReceipt>(await f.correct('A', 6, null, 2, 'commit_clear_six'))
  assert.equal(cleared.pointState!.cards[5].ownerUserId, null)
  assert.deepEqual(Object.values(cleared.pointState!.earnedPoints), [0, 0, 0])
  assert.equal(cardQueries, 3)
  assert.equal(transactions, 6)
  assert.equal(
    reads.some((name) => ['point_results', 'point_changes', 'point_totals'].includes(name)),
    false,
  )
})

test('旧请求回放原始持久化投影，后续命令不会重造或改写旧回执，历史无投影收据兼容', async () => {
  const f = await setup()
  const first = unwrap<CommandReceipt>(await f.claim('A', 3, 0, 'projection_original'))
  const copy = structuredClone(first)
  unwrap(await f.correct('B', 3, f.ids[1], 1))
  const before = f.store.documents('point_changes')
  const originalTransaction = f.store.transaction.bind(f.store)
  f.store.transaction = (operation) =>
    originalTransaction((tx) =>
      operation({
        ...tx,
        async listPointCards() {
          throw new Error('replay must not rebuild a projection')
        },
      }),
    )
  assert.deepEqual(unwrap(await f.claim('A', 3, 0, 'projection_original')), copy)
  assert.deepEqual(first, copy)
  assert.deepEqual(f.store.documents('point_changes'), before)
  const command = f.store
    .documents('commands')
    .find((item) => item.result.requestId === first.requestId)!
  assert.deepEqual(command.result, copy)
  const { pointState: _oldProjection, ...legacy } = command.result
  await f.store.transaction((tx) => tx.set('commands', { ...command, result: legacy }))
  assert.deepEqual(unwrap(await f.claim('A', 3, 0, 'projection_original')), legacy)
})

test('同牌并发竞争仅成功方有投影，非法身份和事务回滚不产生成功回执', async () => {
  const f = await setup()
  const pair = await Promise.all([
    f.claim('A', 4, 0, 'projection_race_A'),
    f.claim('B', 4, 0, 'projection_race_B'),
  ])
  assert.equal(pair.filter((result) => result.ok).length, 1)
  const winner = pair.find((result) => result.ok)!
  assert.equal(unwrap<CommandReceipt>(winner).pointState!.cards[3].revision, 1)
  assert.equal(code(pair.find((result) => !result.ok)!), 'CONFLICT')
  assert.equal(code(await f.claim('D', 5, 0, 'projection_denied')), 'FORBIDDEN')
  assert.equal(code(await f.claim('', 5, 0, 'projection_no_identity')), 'UNAUTHENTICATED')
  const collections = [
    'activity_cards',
    'activity_scores',
    'activities',
    'point_changes',
    'commands',
    'notification_outbox',
  ] as const
  const before = collections.map((name) => f.store.documents(name))
  f.store.failCollection = 'commands'
  const failure = await f.claim('A', 5, 0, 'projection_rollback')
  assert.equal(code(failure), 'INTERNAL_ERROR')
  assert.equal('data' in failure, false)
  assert.deepEqual(
    collections.map((name) => f.store.documents(name)),
    before,
  )
  const recovered = unwrap<CommandReceipt>(await f.claim('A', 5, 0, 'projection_rollback'))
  assert.equal(recovered.pointState!.cards[4].ownerUserId, f.ids[0])
  assert.equal(recovered.pointState!.change.requestId, 'projection_rollback')
})

test('post成功回执仍无pointState，保持原有保存协议', async () => {
  const f = await setup()
  for (let number = 1; number <= 15; number++) unwrap(await f.claim('A', number))
  const saved = unwrap<CommandReceipt>(await f.post())
  assert.equal(Object.hasOwn(saved, 'pointState'), false)
  assert.equal((await f.state()).activity!.status, 'posted')
})
