import { defineConfig } from '@tarojs/cli'
import cloudbase from '../../../cloudbaserc.json'

const backend = process.env.TARO_APP_BACKEND ?? 'mock'
if (backend !== 'mock' && backend !== 'cloud' && backend !== 'http')
  throw new Error('TARO_APP_BACKEND must be mock, cloud or http')

const apiBaseUrl = process.env.TARO_APP_API_BASE_URL ?? process.env.API_BASE_URL ?? ''
const insecureDevelopment =
  process.env.NODE_ENV === 'development' &&
  process.argv.includes('--watch') &&
  process.env.TARO_APP_HTTP_ALLOW_INSECURE === 'true'
// Taro's config loader transpiles only this directory, not application TS imports.
// Keep this build-time gate self-contained; runtime validation remains in platform/http.
const origin = apiBaseUrl.replace(/\/$/, '')
if (
  backend === 'http' &&
  !/^https:\/\/[a-z\d.-]+(?::\d+)?$/i.test(origin) &&
  !(insecureDevelopment && /^http:\/\/[a-z\d.-]+(?::\d+)?$/i.test(origin))
)
  throw new Error('请配置合法HTTPS服务地址；开发HTTP地址仅限开发watch模式显式启用')

export default defineConfig({
  projectName: 'scoreboard',
  date: '2026-10-20',
  designWidth: 390,
  deviceRatio: { 390: 750 / 390 },
  sourceRoot: 'src',
  outputRoot: 'dist',
  framework: 'react',
  compiler: 'vite',
  plugins: ['@tarojs/plugin-platform-weapp'],
  env: {
    TARO_APP_API_BASE_URL: JSON.stringify(apiBaseUrl),
    TARO_APP_HTTP_ALLOW_INSECURE: JSON.stringify(
      process.env.TARO_APP_HTTP_ALLOW_INSECURE ?? 'false',
    ),
    TARO_APP_BACKEND: JSON.stringify(backend),
    TARO_APP_CLOUD_ENV: JSON.stringify(process.env.TARO_APP_CLOUD_ENV ?? cloudbase.envId),
  },
  mini: {
    // Taro 4.3's compressed React alias also matches zustand/react in custom modes.
    // Use its supported debug path to preserve Zustand's actual React bindings.
    debugReact: true,
  },
})
