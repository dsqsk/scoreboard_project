import test from 'node:test'
import assert from 'node:assert/strict'
import { observeHandler, type RequestTiming } from '../src/infrastructure/observe-handler'
import { defineHandler } from '../src/infrastructure/handler'
import { z } from 'zod'

test('生产计时仅输出允许的动作、耗时和成功状态，不泄露请求或异常', async () => {
  const timings: RequestTiming[] = []
  let time = 0
  const wrap = (ok: boolean) =>
    observeHandler(
      async () =>
        ok
          ? { ok: true as const, data: { secret: 'response only' } }
          : {
              ok: false as const,
              error: { code: 'INVALID_ARGUMENT' as const, message: 'private' },
            },
      new Set(['point.getState']),
      (timing) => {
        timings.push(timing)
      },
      () => (time += 4),
    )
  const input = { action: 'point.getState', payload: { roomId: 'private' }, userInfo: 'credential' }
  assert.equal((await wrap(true)(input)).ok, true)
  assert.equal((await wrap(false)({ ...input, action: 'credential' })).ok, false)
  assert.deepEqual(timings, [
    { action: 'point.getState', durationMs: 4, success: true },
    { action: 'invalid', durationMs: 4, success: false },
  ])
  const throws = observeHandler(
    async () => {
      throw new Error('private')
    },
    new Set(),
    (timing) => {
      timings.push(timing)
    },
    () => 0,
  )
  await assert.rejects(throws(input), /private/)
  assert.deepEqual(timings[2], { action: 'invalid', durationMs: 0, success: false })
  const brokenLogger = observeHandler(
    async () => ({ ok: true as const, data: 1 }),
    new Set(),
    () => {
      throw new Error('logger down')
    },
  )
  assert.deepEqual(await brokenLogger(null), { ok: true, data: 1 })
})

test('unknown failure logs only numeric or allowed platform codes and never raw SDK data', async () => {
  const logs: unknown[][] = []
  const previous = console.error
  console.error = (...values: unknown[]) => {
    logs.push(values)
  }
  try {
    for (const error of [
      { errCode: -502005, errMsg: 'private-room/private-token' },
      { code: 'private-token', stack: 'private-stack' },
    ]) {
      const handle = defineHandler(z.object({}), async () => {
        throw error
      })
      assert.deepEqual(await handle({}), {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' },
      })
    }
    assert.deepEqual(logs, [
      ['Unhandled cloud function error', { code: -502005 }],
      ['Unhandled cloud function error', { code: 'UNKNOWN' }],
    ])
    assert.doesNotMatch(JSON.stringify(logs), /private/)
  } finally {
    console.error = previous
  }
})
