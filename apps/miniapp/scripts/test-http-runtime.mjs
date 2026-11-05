import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
for (const mode of ['http', 'cloud', 'mock', 'http-insecure', 'cloud-existing-watch']) {
  const code = await build({
    stdin: {
      contents: `export {roomApi,isMock} from './src/runtime'; export {backendScope} from './src/platform/backend'; export {pointApi} from './src/features/point/runtime'; export {daAApi} from './src/features/da-a/runtime'; export {profileSession} from './src/features/profile/runtime';`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    define: {
      'process.env.TARO_APP_BACKEND': JSON.stringify(
        mode === 'http-insecure' ? 'http' : mode === 'cloud-existing-watch' ? 'cloud' : mode,
      ),
      ...(mode === 'cloud-existing-watch'
        ? {}
        : {
            'process.env.TARO_APP_API_BASE_URL': JSON.stringify(
              mode === 'http-insecure' ? 'http://127.0.0.1:3000' : 'https://api.siteforsk.ink',
            ),
          }),
      'process.env.TARO_APP_CLOUD_ENV': '"cloud-env"',
      ...(mode === 'cloud-existing-watch'
        ? {}
        : {
            'process.env.TARO_APP_HTTP_ALLOW_INSECURE': JSON.stringify(
              mode === 'http-insecure' ? 'true' : 'false',
            ),
          }),
      'process.env.NODE_ENV': '"production"',
    },
    plugins: [
      {
        name: 'taro-stub',
        setup(build) {
          build.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({
            path: 'taro',
            namespace: 'stub',
          }))
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            loader: 'js',
            contents: `export default globalThis.taro;`,
          }))
        },
      },
    ],
  })
  let logins = 0,
    httpCalls = 0,
    cloudCalls = 0
  const storage = new Map()
  const me = { userId: 'user', displayName: '昵称', avatarFileId: null, profileCompleted: true }
  const taro = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, v) => storage.set(key, v),
    removeStorageSync: (key) => storage.delete(key),
    async login() {
      logins++
      return { code: 'code' }
    },
    async request(input) {
      httpCalls++
      return input.url.endsWith('/auth/wechat')
        ? {
            statusCode: 200,
            data: { ok: true, data: { accessToken: 'token', expiresAt: Date.now() + 60000 } },
          }
        : { statusCode: 200, data: { ok: true, data: me } }
    },
  }
  const diagnostics = []
  const exports = {}
  const context = vm.createContext({
    exports,
    module: { exports },
    taro,
    console: { ...console, error: (...args) => diagnostics.push(args) },
    setTimeout,
    clearTimeout,
    wx: {
      cloud: {
        Cloud: class {
          async init() {}
          async callFunction() {
            cloudCalls++
            return { result: { ok: true, data: me } }
          }
        },
      },
    },
  })
  vm.runInContext(code.outputFiles[0].text, context)
  const bound = context.module.exports
  const api = bound.roomApi
  if (mode === 'http-insecure') {
    await assert.rejects(api.getMe())
    assert.equal(logins, 0)
    assert.equal(httpCalls, 0)
    assert.equal(cloudCalls, 0)
    continue
  }
  const user = await api.getMe()
  if (mode === 'http') {
    assert.equal(user.userId, 'user')
    assert.equal(logins, 1)
    assert.equal(httpCalls, 2)
    assert.equal(cloudCalls, 0)
    assert.equal(bound.backendScope, 'http.https%3A%2F%2Fapi.siteforsk.ink')
    const successfulRequest = taro.request
    taro.request = async () => {
      throw { errMsg: 'request:fail net::ERR_CONNECTION_RESET code=SECRET-CODE', token: 'SECRET' }
    }
    await assert.rejects(api.getMe(), { code: 'TRANSPORT_UNKNOWN' })
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0][0], '[http-connection]')
    assert.equal(diagnostics[0][1].reason, 'ERR_CONNECTION_RESET')
    assert.equal(diagnostics[0][1].path, '/api')
    assert.equal(JSON.stringify(diagnostics).includes('SECRET'), false)
    taro.request = successfulRequest
  } else if (mode === 'cloud' || mode === 'cloud-existing-watch') {
    assert.equal(user.userId, 'user')
    assert.equal(logins, 0)
    assert.equal(httpCalls, 0)
    assert.equal(cloudCalls, 1)
    assert.equal(bound.backendScope, 'cloud-env')
  } else {
    assert.equal(bound.isMock, true)
    assert.equal(logins, 0)
    assert.equal(httpCalls, 0)
    assert.equal(cloudCalls, 0)
    assert.equal(bound.backendScope, 'mock')
  }
}
console.log(
  'PASS: HTTP/cloud/mock runtime routing and journal scopes are isolated; no cloud fallback',
)

// Exercise the real Taro config without launching the native compiler or changing dist.
const configBundle = await build({
  entryPoints: [fileURLToPath(new URL('../config/index.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'cli-config-stub',
      setup(build) {
        build.onResolve({ filter: /^@tarojs\/cli$/ }, () => ({
          path: 'cli',
          namespace: 'config-stub',
        }))
        build.onLoad({ filter: /.*/, namespace: 'config-stub' }, () => ({
          loader: 'js',
          contents: 'export const defineConfig = value => value;',
        }))
      },
    },
  ],
})
for (const scenario of [
  { node: 'production', watch: false, flag: 'true', base: 'http://101.201.236.27', valid: false },
  { node: 'development', watch: false, flag: 'true', base: 'http://101.201.236.27', valid: false },
  { node: 'development', watch: true, flag: 'false', base: 'http://101.201.236.27', valid: false },
  { node: 'development', watch: true, flag: 'true', base: 'http://101.201.236.27', valid: true },
  {
    node: 'production',
    watch: false,
    flag: 'false',
    base: 'https://api.siteforsk.ink',
    valid: true,
  },
]) {
  const exports = {}
  const context = vm.createContext({
    exports,
    module: { exports },
    process: {
      argv: scenario.watch ? ['taro', 'build', '--watch'] : ['taro', 'build'],
      env: {
        NODE_ENV: scenario.node,
        TARO_APP_BACKEND: 'http',
        TARO_APP_API_BASE_URL: scenario.base,
        TARO_APP_HTTP_ALLOW_INSECURE: scenario.flag,
      },
    },
  })
  const run = () => vm.runInContext(configBundle.outputFiles[0].text, context)
  if (scenario.valid) run()
  else assert.throws(run)
}
console.log('PASS: real Taro config permits explicit IP dev/watch only; production rejects HTTP')

// Taro only transpiles config/*.ts. Do not let an esbuild bundle hide imports
// of untranspiled application TypeScript from the real configuration loader.
const appPath = fileURLToPath(new URL('..', import.meta.url))
for (const scenario of [
  { backend: 'cloud', node: 'development', watch: true, flag: 'false', base: '', valid: true },
  {
    backend: 'http',
    node: 'development',
    watch: true,
    flag: 'true',
    base: 'http://101.201.236.27',
    valid: true,
  },
  {
    backend: 'http',
    node: 'production',
    watch: false,
    flag: 'true',
    base: 'http://101.201.236.27',
    valid: false,
  },
  {
    backend: 'http',
    node: 'production',
    watch: false,
    flag: 'false',
    base: 'https://api.siteforsk.ink',
    valid: true,
  },
]) {
  const loaded = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const path = require('node:path');
    require('@tarojs/helper').createSwcRegister({
      only: [file => file.includes(path.join(process.cwd(), 'config'))],
    });
    if (${scenario.watch}) process.argv.push('--watch');
    const config = require(path.join(process.cwd(), 'config/index.ts')).default;
    require('node:assert/strict').equal(JSON.parse(config.env.TARO_APP_BACKEND), process.env.TARO_APP_BACKEND);
  `,
    ],
    {
      cwd: appPath,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: scenario.node,
        TARO_APP_BACKEND: scenario.backend,
        TARO_APP_API_BASE_URL: scenario.base,
        TARO_APP_HTTP_ALLOW_INSECURE: scenario.flag,
      },
    },
  )
  const output = loaded.stderr + loaded.stdout
  if (scenario.valid) assert.equal(loaded.status, 0, output)
  else {
    assert.notEqual(loaded.status, 0)
    assert.match(output, /HTTPS/)
    assert.doesNotMatch(output, /SyntaxError/)
  }
}
console.log('PASS: installed Taro SWC loader reads cloud/IP/HTTPS config; production HTTP rejected')

const httpsDefaults = readFileSync(new URL('../.env.http', import.meta.url), 'utf8')
assert.match(httpsDefaults, /^TARO_APP_BACKEND=http$/m)
assert.match(httpsDefaults, /^TARO_APP_API_BASE_URL=https:\/\/api\.siteforsk\.ink$/m)
assert.match(httpsDefaults, /^TARO_APP_HTTP_ALLOW_INSECURE=false$/m)
console.log('PASS: explicit HTTP mode defaults to api.siteforsk.ink HTTPS with insecure disabled')
