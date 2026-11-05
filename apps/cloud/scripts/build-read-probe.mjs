import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sdk = JSON.parse(await readFile(require.resolve('wx-server-sdk/package.json'), 'utf8'))
const folder = 'dist/read_probe'
await mkdir(folder, { recursive: true })
await build({
  stdin: {
    contents: `
      import { getCloud } from './src/infrastructure/cloud'
      import { createWxStore } from './src/repositories/wx-store'
      import { probePointReads } from './src/diagnostics/point-read-probe'
      export async function main(event) {
        try {
          return await probePointReads(createWxStore(getCloud().database({ throwOnNotFound: false })), event)
        } catch {
          return { ok: false, code: 'PROBE_FAILED' }
        }
      }
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: `${folder}/index.js`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['wx-server-sdk'],
})
await writeFile(
  `${folder}/package.json`,
  JSON.stringify(
    {
      name: 'read_probe',
      version: '0.1.0',
      main: 'index.js',
      dependencies: { 'wx-server-sdk': sdk.version },
    },
    null,
    2,
  ) + '\n',
)
console.log('Built management-only read probe; not included in cloudbaserc deployment list')
