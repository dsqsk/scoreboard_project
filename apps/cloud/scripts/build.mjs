import { build } from 'esbuild'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const require = createRequire(import.meta.url)
const sdk = JSON.parse(await readFile(require.resolve('wx-server-sdk/package.json'), 'utf8'))
const functions = await readdir('src/functions', { withFileTypes: true })
for (const entry of functions.filter((entry) => entry.isDirectory())) {
  const output = join('dist', entry.name)
  await mkdir(output, { recursive: true })
  await build({
    entryPoints: [join('src/functions', entry.name, 'index.ts')],
    outfile: join(output, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['wx-server-sdk'],
  })
  await writeFile(
    join(output, 'package.json'),
    JSON.stringify(
      {
        name: entry.name,
        version: manifest.version,
        main: 'index.js',
        dependencies: { 'wx-server-sdk': sdk.version },
      },
      null,
      2,
    ) + '\n',
  )
}
