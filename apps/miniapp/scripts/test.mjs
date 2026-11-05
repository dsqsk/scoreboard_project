import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const directory = await mkdtemp(join(tmpdir(), 'scoreboard-ui-tests-'))
try {
  const output = join(directory, 'foundation.test.cjs')
  await build({
    entryPoints: ['src/tests/foundation.test.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
  })
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  await rm(directory, { recursive: true, force: true })
}
