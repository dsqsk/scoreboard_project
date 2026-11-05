import { build } from 'esbuild'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const output = await mkdtemp(join(tmpdir(), 'scoreboard-tests-'))
try {
  const tests = (await readdir('test')).filter((file) => file.endsWith('.test.ts'))
  await build({
    entryPoints: tests.map((file) => join('test', file)),
    outdir: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
  })
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', ...tests.map((file) => join(output, file.replace(/\.ts$/, '.js')))],
      { stdio: 'inherit' },
    )
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
  process.exitCode = exitCode
} finally {
  await rm(output, { recursive: true, force: true })
}
