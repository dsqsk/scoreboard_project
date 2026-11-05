import { build } from 'esbuild'
import vm from 'node:vm'
import assert from 'node:assert/strict'

// WeChat permits Function detection but does not return executable generated code.
// Run the real adapters in an isolated runtime so parser caches cannot hide this bug.
async function run(disableFix) {
  const bundle = await build({
    stdin: {
      contents: `export { createCloudRoomApi } from './src/modules/room-api/cloud'; export { createCloudPointApi } from './src/features/point/cloud'`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
  })
  let code = bundle.outputFiles[0].text
  if (disableFix) code = code.replaceAll('{ jitless: true }', '{}')
  const context = vm.createContext({ exports: {}, module: { exports: {} } })
  vm.runInContext('Function = new Proxy(Function, { construct() { return {} } })', context)
  vm.runInContext(code, context)
  const { createCloudRoomApi, createCloudPointApi } = context.module.exports
  const calls = []
  const transport = {
    init() {},
    async call(request) {
      calls.push(request.action)
      return { ok: true, data: { userId: 'user-one', displayName: '玩家' } }
    },
  }
  await createCloudRoomApi('test-env', transport).getMe()
  const point = createCloudPointApi('test-env', transport)
  // Invalid response is deliberate: request validation must reach the transport.
  await assert.rejects(point.get('room-one'), (error) => error.code === 'INVALID_RESPONSE')
  assert.deepEqual(calls, ['identity.getMe', 'point.getState'])
}

await assert.rejects(run(true), /not a function/)
await run(false)
console.log(
  'PASS: WeChat Function restriction reproduced; room and point validation reach transport with fix',
)

// Independent native Cloud instance: shared initialization, preserved method receiver,
// and retry after an initialization failure.
const nativeBundle = await build({
  entryPoints: ['src/platform/cloud.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  define: {
    'process.env.TARO_APP_CLOUD_ENV': '"test-env"',
    'process.env.NODE_ENV': '"production"',
  },
})
let instances = 0
let initializations = 0
let rejectInit = true
class NativeCloud {
  constructor({ resourceEnv }) {
    assert.equal(resourceEnv, 'test-env')
    this.validReceiver = true
    instances++
  }
  async init() {
    assert.equal(this.validReceiver, true)
    initializations++
    if (rejectInit) {
      rejectInit = false
      throw new Error('init unavailable')
    }
  }
  async callFunction({ data }) {
    assert.equal(this.validReceiver, true)
    return { result: data.action }
  }
}
const nativeContext = vm.createContext({
  module: { exports: {} },
  exports: {},
  wx: { cloud: { Cloud: NativeCloud } },
})
vm.runInContext(nativeBundle.outputFiles[0].text, nativeContext)
const nativeApi = nativeContext.module.exports
await assert.rejects(
  nativeApi.callCloud({ action: 'identity.getMe', payload: {} }),
  /init unavailable/,
)
const nativeResults = await Promise.all([
  nativeApi.callCloud({ action: 'identity.getMe', payload: {} }),
  nativeApi.callCloud({ action: 'room.listRecent', payload: {} }),
])
assert.deepEqual(nativeResults, ['identity.getMe', 'room.listRecent'])
assert.equal(instances, 2)
assert.equal(initializations, 2)
console.log(
  'PASS: native Cloud initializes once, preserves receiver and retries initialization failure',
)

const debugBundle = await build({
  entryPoints: ['src/platform/cloud.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  define: {
    'process.env.TARO_APP_CLOUD_ENV': '"test-env"',
    'process.env.NODE_ENV': '"development"',
  },
})
const timings = []
const transportFailure = new Error('private transport failure')
let response = { ok: true, data: 'private response' }
let failTransport = false
let failLogger = false
class DebugCloud {
  async init() {}
  async callFunction() {
    if (failTransport) throw transportFailure
    return { result: response }
  }
}
const debugContext = vm.createContext({
  module: { exports: {} },
  exports: {},
  wx: { cloud: { Cloud: DebugCloud } },
  console: {
    info(label, timing) {
      if (failLogger) throw new Error('logger unavailable')
      timings.push({ label, ...timing })
    },
  },
})
vm.runInContext(debugBundle.outputFiles[0].text, debugContext)
const debugApi = debugContext.module.exports
const request = { action: 'identity.getMe', payload: { private: 'never log' } }
assert.equal(await debugApi.callCloud(request), response)
response = { ok: false, error: { code: 'FORBIDDEN', message: 'private business failure' } }
assert.equal(await debugApi.callCloud(request), response)
failTransport = true
await assert.rejects(debugApi.callCloud(request), (error) => error === transportFailure)
assert.deepEqual(
  timings.map((timing) => timing.success),
  [true, false, false],
)
for (const timing of timings) {
  assert.deepEqual(Object.keys(timing).sort(), [
    'action',
    'callFunctionMs',
    'initializationMs',
    'label',
    'success',
    'totalMs',
  ])
  assert.equal(timing.action, 'identity.getMe')
  assert.ok(timing.totalMs >= 0)
}
failTransport = false
failLogger = true
assert.equal(await debugApi.callCloud(request), response)
console.log('PASS: development timing preserves results/errors and excludes private data')
