import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  ApiResult,
  FoundationResponse,
  CommandReceipt,
  IdentityDTO,
  DaASnapshot,
} from '@scoreboard/shared'
import { DA_A_VALUES, daADeltaUnits } from '@scoreboard/shared'
import { createApi } from '../src/services/api'
import { MemoryStore } from './memory-store'
import { stableId } from '../src/infrastructure/ids'

function ok<T>(result: ApiResult<FoundationResponse>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error))
  return result.data as T
}
function error(result: ApiResult<FoundationResponse>) {
  if (result.ok) assert.fail('expected error')
  return result.error.code
}
async function fixture(baseStake = 5) {
  const store = new MemoryStore()
  let now = 100000,
    seq = 0,
    code = 200000
  const call = (
    who: string,
    action: string,
    payload: object = {},
    requestId?: string,
    appId = 'wx-test',
  ) =>
    createApi({ store, now: () => ++now, joinCode: () => String(++code) }, () => ({
      openId: who,
      appId,
    }))({ action, payload, ...(requestId ? { requestId } : {}) })
  const users = await Promise.all(
    ['A', 'B', 'C', 'D', 'E', 'F'].map(async (who) =>
      ok<IdentityDTO>(await call(who, 'identity.getMe')),
    ),
  )
  const created = ok<CommandReceipt>(
    await call('A', 'daA.createRoom', { baseStake }, 'create_da_a_room'),
  )
  for (const who of ['B', 'C', 'D', 'E'])
    ok(await call(who, 'room.join', { joinCode: created.joinCode }, `join_da_a_${who}`))
  const roomId = created.roomId!
  const get = async (who = 'A', cursor?: string) =>
    ok<DaASnapshot>(await call(who, 'daA.getState', { roomId, ...(cursor ? { cursor } : {}) }))
  const prepare = (
    participantIds = users.slice(0, 5).map((u) => u.userId),
    expectedRoomRevision = 4,
    requestId = 'prepare_da_a',
  ) => call('A', 'daA.prepare', { roomId, participantIds, expectedRoomRevision }, requestId)
  const prepared = ok<CommandReceipt>(await prepare())
  const write = (
    who = 'A',
    direction = 1,
    value = 6,
    mingA = false,
    requestId = `da_a_write_${++seq}`,
    extra = {},
  ) =>
    call(
      who,
      'daA.addDelta',
      {
        roomId,
        activityId: prepared.activityId,
        expectedConfigRevision: 0,
        direction,
        value,
        mingA,
        ...extra,
      },
      requestId,
    )
  return { store, call, users, created, prepared, roomId, get, prepare, write }
}

test('all preset/value/sign/mingA combinations use exact units; create and prepare freeze five without slots', async () => {
  for (const base of [1, 5, 10])
    for (const value of DA_A_VALUES)
      for (const direction of [1, -1])
        for (const mingA of [false, true])
          assert.equal(
            daADeltaUnits(base, direction, value, mingA),
            base * value * direction * (mingA ? 2 : 1) * 100,
          )
  for (const args of [
    [2, 1, 6, false],
    [5, 0, 6, false],
    [5, 1, 5, false],
  ] as const)
    assert.throws(() => daADeltaUnits(args[0], args[1], args[2], args[3]))
  const f = await fixture()
  const state = await f.get()
  assert.equal(state.baseStake, 5)
  assert.equal(state.scoreScale, 100)
  assert.equal(state.canRecord, true)
  assert.equal(state.activity?.participants.length, 5)
  assert.equal(f.store.documents('result_slots').length, 0)
  assert.equal(f.store.documents('activities')[0].currentResultToken, null)
  assert.deepEqual(state.entries, [])
  assert.deepEqual(state.totalsUnits, {})
  const createAgain = ok<CommandReceipt>(
    await f.call('A', 'daA.createRoom', { baseStake: 5 }, 'create_da_a_room'),
  )
  assert.deepEqual(createAgain, f.created)
  assert.equal(f.store.documents('rooms').length, 1)
})

test('preset API round trips validate every button, sign and per-entry mingA without persistent toggles', async () => {
  for (const baseStake of [1, 5, 10]) {
    const f = await fixture(baseStake)
    for (const value of DA_A_VALUES)
      for (const direction of [1, -1])
        for (const mingA of [true, false]) {
          ok(await f.write('A', direction, value, mingA))
          const entry = (await f.get()).entries[0]
          assert.equal(entry.deltaUnits, direction * value * baseStake * (mingA ? 2 : 1) * 100)
          assert.equal(entry.baseStake, baseStake)
        }
    assert.equal((await f.get()).totalsUnits[f.users[0].userId], 0)
    assert.equal(f.store.documents('da_a_entries').length, 32)
  }
})

test('waiting room reads with no activity; preparation rejects an unjoined member with no partial writes', async () => {
  const f = await fixture()
  const waiting = ok<CommandReceipt>(
    await f.call('A', 'daA.createRoom', { baseStake: 10 }, 'waiting_da_a_room'),
  )
  const state = ok<DaASnapshot>(await f.call('A', 'daA.getState', { roomId: waiting.roomId }))
  assert.equal(state.activity, null)
  assert.equal(state.canRecord, false)
  assert.equal(state.baseStake, 10)
  assert.deepEqual(state.entries, [])
  assert.deepEqual(state.totalsUnits, {})
  assert.equal(
    error(
      await f.call(
        'A',
        'daA.prepare',
        {
          roomId: waiting.roomId,
          expectedRoomRevision: 0,
          participantIds: f.users.slice(0, 5).map((u) => u.userId),
        },
        'unjoined_prepare',
      ),
    ),
    'FORBIDDEN',
  )
  assert.equal(f.store.documents('activities').length, 1)
  assert.equal(f.store.documents('activity_scores').length, 5)
})

test('A02/A04 saves +30/-60 only for caller, captures history name and all members read it', async () => {
  const f = await fixture()
  const name = (await f.get()).activity!.participants[0].displayName
  ok(await f.call('A', 'identity.updateProfile', { displayName: '新昵称' }, 'change_profile_name'))
  ok(await f.write())
  ok(await f.write('A', -1, 6, true))
  const state = await f.get('B')
  assert.deepEqual(
    state.entries.map((e) => e.deltaUnits),
    [-6000, 3000],
  )
  assert.deepEqual(
    state.entries.map((e) => e.displayName),
    [name, name],
  )
  assert.deepEqual(state.totalsUnits, { [f.users[0].userId]: -3000 })
  const scores = f.store.documents('activity_scores')
  assert.equal(scores.find((s) => s.userId === f.users[0].userId)!.netUnits, -3000)
  assert.ok(scores.filter((s) => s.userId !== f.users[0].userId).every((s) => s.netUnits === 0))
  assert.equal(state.activity!.participants[0].displayName, name)
})

test('same request exactly once, differing payload rejected, independent callers and confirmations retained', async () => {
  const f = await fixture()
  const result = await Promise.all(
    Array.from({ length: 5 }, () => f.write('A', 1, 6, false, 'same_confirmation')),
  )
  assert.ok(result.every((r) => JSON.stringify(r) === JSON.stringify(result[0])))
  assert.equal(error(await f.write('A', -1, 6, false, 'same_confirmation')), 'IDEMPOTENCY_MISMATCH')
  ok(await f.write('A', 1, 6, false, 'new_confirmation'))
  await Promise.all(
    ['B', 'C', 'D', 'E'].map((who) => f.write(who, 1, 1, false, 'same_confirmation').then(ok)),
  )
  const state = await f.get()
  assert.equal(state.entries.length, 6)
  assert.equal(state.totalsUnits[f.users[0].userId], 6000)
  assert.ok(f.users.slice(1, 5).every((u) => state.totalsUnits[u.userId] === 500))
})

test('fixed roster survives late joins; nonparticipants read but cannot write; unknown fields and cross-app denied', async () => {
  const f = await fixture()
  ok(await f.call('F', 'room.join', { joinCode: f.created.joinCode }, 'late_member_join'))
  const before = await f.get()
  assert.equal((await f.get('F')).canRecord, false)
  assert.equal(error(await f.write('F')), 'FORBIDDEN')
  assert.equal(
    error(await f.write('A', 1, 6, false, undefined, { userId: f.users[1].userId })),
    'INVALID_ARGUMENT',
  )
  assert.equal(
    error(await f.write('A', 1, 6, false, undefined, { deltaUnits: 1 })),
    'INVALID_ARGUMENT',
  )
  assert.equal(error(await f.call('outsider', 'daA.getState', { roomId: f.roomId })), 'FORBIDDEN')
  assert.equal(
    error(await f.call('A', 'daA.getState', { roomId: f.roomId }, undefined, 'wx-other')),
    'FORBIDDEN',
  )
  assert.deepEqual((await f.get()).activity, before.activity)
  assert.equal(
    error(
      await f.prepare(
        f.users.slice(1).map((u) => u.userId),
        6,
        'no_actor_prepare',
      ),
    ),
    'FORBIDDEN',
  )
})

test('prepare validates exactly five distinct valid members, revision, and does not replace open activity', async () => {
  const f = await fixture()
  assert.equal(error(await f.prepare(f.users.slice(0, 4).map((u) => u.userId))), 'INVALID_ARGUMENT')
  assert.equal(error(await f.prepare(Array(5).fill(f.users[0].userId))), 'INVALID_ARGUMENT')
  assert.equal(error(await f.prepare(undefined, 0, 'stale_prepare')), 'STALE_CONTEXT')
  assert.equal(error(await f.prepare(undefined, 5, 'replace_open_prepare')), 'CONFLICT')
  assert.deepEqual(ok(await f.prepare()), f.prepared)
  assert.equal(
    error(
      await f.call(
        'A',
        'activity.prepare',
        {
          roomId: f.roomId,
          expectedRoomRevision: 5,
          participantIds: f.users.slice(0, 5).map((u) => u.userId),
          configInput: { baseStake: '10' },
        },
        'bypass_generic_prepare',
      ),
    ),
    'RULE_NOT_CONFIGURED',
  )
})

test('invalid options/config/old activity rejected; saved receipt survives later close without another posting', async () => {
  const f = await fixture()
  for (const extra of [{ direction: 0 }, { value: 5 }, { mingA: 1 }, { baseStake: 10 }])
    assert.equal(error(await f.write('A', 1, 6, false, undefined, extra)), 'INVALID_ARGUMENT')
  assert.equal(
    error(await f.write('A', 1, 6, false, undefined, { expectedConfigRevision: 1 })),
    'STALE_CONTEXT',
  )
  assert.equal(
    error(await f.write('A', 1, 6, false, undefined, { activityId: 'old_activity' })),
    'STALE_CONTEXT',
  )
  const receipt = await f.write('A', 1, 6, false, 'saved_before_close')
  ok(receipt)
  await f.store.transaction(async (tx) => {
    const room = (await tx.get('rooms', f.roomId))!
    await tx.set('rooms', { ...room, status: 'closed' })
  })
  assert.deepEqual(await f.write('A', 1, 6, false, 'saved_before_close'), receipt)
  assert.equal(error(await f.write()), 'NOT_FOUND')
  assert.equal(f.store.documents('da_a_entries').length, 1)
})

test('transaction failure rolls back entry, scores, totals, outbox and receipt; original request recovers', async () => {
  for (const collection of [
    'da_a_entries',
    'da_a_totals',
    'activity_scores',
    'activities',
    'notification_outbox',
    'commands',
  ] as const) {
    const f = await fixture()
    const before = await f.get()
    const events = f.store.documents('notification_outbox').length
    f.store.failCollection = collection
    assert.equal(error(await f.write('A', 1, 6, false, 'rollback_request')), 'INTERNAL_ERROR')
    assert.deepEqual(await f.get(), before)
    assert.equal(f.store.documents('notification_outbox').length, events)
    ok(await f.write('A', 1, 6, false, 'rollback_request'))
    assert.equal((await f.get()).totalsUnits[f.users[0].userId], 3000)
  }
})

test('overflow rejects atomically; legacy unconfigured rooms never get a guessed base', async () => {
  const f = await fixture()
  ok(await f.write())
  await f.store.transaction(async (tx) => {
    const aggregate = f.store.documents('da_a_totals')[0]
    await tx.set('da_a_totals', {
      ...aggregate,
      totalsUnits: { [f.users[0].userId]: Number.MAX_SAFE_INTEGER },
    })
  })
  assert.equal(error(await f.write()), 'CONFLICT')
  assert.equal(f.store.documents('da_a_entries').length, 1)
  for (const baseStake of [0, 2, 1.5, '5', 100])
    assert.equal(
      error(await f.call('A', 'daA.createRoom', { baseStake }, 'invalid_base_stake')),
      'INVALID_ARGUMENT',
    )
  const old = ok<CommandReceipt>(
    await f.call('A', 'room.create', { mode: 'da_a' }, 'legacy_empty_room'),
  )
  assert.equal(
    error(await f.call('A', 'daA.getState', { roomId: old.roomId })),
    'RULE_NOT_CONFIGURED',
  )
})

test('stable history pagination spans activities, late writes and rooms; totals cover all pages', async () => {
  const f = await fixture()
  for (let i = 0; i < 23; i++) ok(await f.write('A', 1, 1))
  const first = await f.get()
  assert.equal(first.entries.length, 20)
  assert.ok(first.nextCursor)
  await f.store.transaction(async (tx) => {
    const activity = (await tx.get('activities', f.prepared.activityId!))!
    await tx.set('activities', { ...activity, status: 'archived' })
  })
  const next = ok<CommandReceipt>(await f.prepare(undefined, 5, 'next_prepared_test'))
  ok(await f.write('B', -1, 2, true, 'new_activity_entry', { activityId: next.activityId }))
  const second = await f.get('B', first.nextCursor!)
  assert.equal(second.entries.length, 3)
  assert.equal(second.nextCursor, null)
  assert.equal(second.totalsUnits[f.users[0].userId], 11500)
  assert.equal(second.totalsUnits[f.users[1].userId], -2000)
  const latest = await f.get()
  assert.equal(latest.entries[0].activityId, next.activityId)
  assert.equal(error(await f.write()), 'STALE_CONTEXT')
  const other = ok<CommandReceipt>(
    await f.call('A', 'daA.createRoom', { baseStake: 1 }, 'another_da_a_room'),
  )
  assert.equal(
    error(await f.call('A', 'daA.getState', { roomId: other.roomId, cursor: first.nextCursor })),
    'INVALID_ARGUMENT',
  )
  assert.equal(
    f.store
      .documents('activity_scores')
      .find((s) => s._id === stableId('score', f.prepared.activityId!, f.users[0].userId))!
      .netUnits,
    11500,
  )
})
