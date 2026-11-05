import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sdk = JSON.parse(await readFile(require.resolve('wx-server-sdk/package.json'), 'utf8'))
for (const name of ['profile_probe256', 'profile_probe512']) {
  const folder = `dist/${name}`
  await mkdir(folder, { recursive: true })
  await build({
    stdin: {
      contents: `
      import { getCloud } from './src/infrastructure/cloud'
      import { createWxStore } from './src/repositories/wx-store'
      import { probePointState } from './src/diagnostics/state-read-probe'
      import { profileDatabase } from './src/infrastructure/database-profile'
      export async function main(input) {
        try {
          let profile
          const run = profileDatabase(
            (_event, observer) => probePointState(createWxStore(getCloud().database({throwOnNotFound:false}), observer), input),
            new Set(['point.getState']), value => { profile = value },
          )
          const result = await run({action:'point.getState'})
          return {...result, profile}
        }
        catch { return {ok:false, code:'DIAGNOSTIC_FAILED'} }
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
        name,
        version: '0.1.0',
        main: 'index.js',
        dependencies: { 'wx-server-sdk': sdk.version },
      },
      null,
      2,
    ) + '\n',
  )
}
console.log('Built identical management-only read probes; not in normal deployment list')
