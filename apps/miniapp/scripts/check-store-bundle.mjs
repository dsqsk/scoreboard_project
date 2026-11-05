import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'

const output = fileURLToPath(new URL('../dist/', import.meta.url))
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await check(path)
    else if (entry.name.endsWith('.js')) {
      const code = await readFile(path, 'utf8')
      assert.doesNotMatch(
        code,
        /(?:react_production_min|React|react)\.useStore\s*\(/,
        `Zustand hook incorrectly resolved to React in ${path}`,
      )
    }
  }
}
await check(output)
const exports = {}
const react = {
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useCallback: (callback) => callback,
  useDebugValue: () => {},
}
vm.runInNewContext(await readFile(join(output, 'vendors.js'), 'utf8'), {
  exports,
  require: (id) => {
    assert.equal(id, './taro.js')
    return { React: react, react: react, react_production_min: react }
  },
})
assert.equal(typeof exports.useStore, 'function', 'built Zustand useStore must exist')
const store = exports.createStore(() => ({ count: 7 }))
assert.equal(
  exports.useStore(store, (state) => state.count),
  7,
)
console.log('PASS: built Zustand hook resolves correctly and reads the actual built store')
