import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const config = JSON.parse(await readFile(resolve(root, 'cloudbaserc.json'), 'utf8'))
const require = createRequire(import.meta.url)
for (const fn of config.functions) {
  assert.equal(
    fn.type,
    'Event',
    `${fn.name}: explicitly set type=Event; these exports.main packages are not HTTP/Web servers`,
  )
  assert.equal(fn.handler, 'index.main', `${fn.name}: expected index.main entry point`)
  const folder = resolve(root, config.functionRoot, fn.name)
  const entry = resolve(folder, 'index.js')
  await access(entry)
  const manifest = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'))
  assert.equal(
    manifest.main,
    'index.js',
    `${fn.name}: package entry must be at the function directory root`,
  )
  assert.equal(typeof require(entry).main, 'function', `${fn.name}: built module must export main`)
  assert.ok(
    manifest.dependencies?.['wx-server-sdk'],
    `${fn.name}: declare cloud SDK deployment dependency`,
  )
  console.log(`${fn.name}: Event / ${fn.runtime} / index.main / package root OK`)
}
