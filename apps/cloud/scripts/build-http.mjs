import { build } from 'esbuild'
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises'
const root = JSON.parse(await readFile('package.json', 'utf8'))
await mkdir('dist/http', { recursive: true })
await build({
  entryPoints: {
    server: 'src/http/server.ts',
    migrate: 'src/migration/cli.ts',
    smoke: 'src/diagnostics/mysql-smoke.ts',
  },
  outdir: 'dist/http',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['mysql2/promise'],
})
await writeFile(
  'dist/http/package.json',
  JSON.stringify(
    {
      name: 'scoreboard-http',
      private: true,
      version: root.version,
      engines: { node: '>=22' },
      scripts: { start: 'node server.cjs', migrate: 'node migrate.cjs' },
      dependencies: { mysql2: root.dependencies.mysql2 },
    },
    null,
    2,
  ) + '\n',
)
for (const name of ['scoreboard.service', 'scoreboard.env.example', 'nginx.conf', 'README.md'])
  await copyFile(`deploy/${name}`, `dist/http/${name}`)
