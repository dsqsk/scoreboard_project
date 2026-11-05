import test from 'node:test'
import assert from 'node:assert/strict'
import { stableId } from '../src/infrastructure/ids'
import { createRequire } from 'node:module'

// Exercise the installed SDK's actual transaction/query chain without cloud access.
// This proves client-side propagation, not server acceptance or snapshot isolation.
test('已安装SDK批量查询保留事务ID及limit，只发送一条getDocument请求', async () => {
  const require = createRequire(`${process.cwd()}/package.json`)
  type Sender = { send(action: string, params?: Record<string, unknown>): Promise<unknown> }
  const { Db } = require('@cloudbase/database/dist/commonjs/index.js') as {
    Db: { reqClass: new (...args: unknown[]) => Sender }
  }
  interface Query {
    where(filter: Record<string, unknown>): Query
    limit(count: number): Query
    get(): Promise<unknown>
  }
  const { Transaction } = require('@cloudbase/database/dist/commonjs/transaction/index.js') as {
    Transaction: new (database: { config: object }) => {
      init(): Promise<void>
      collection(name: string): Query
    }
  }
  const saved = Db.reqClass
  const calls: { action: string; params?: Record<string, unknown> }[] = []
  Db.reqClass = class {
    async send(action: string, params?: Record<string, unknown>) {
      calls.push({ action, params })
      return action === 'database.startTransaction'
        ? { transactionId: 'test_tx' }
        : { data: { list: [] } }
    }
  }
  try {
    const tx = new Transaction({ config: {} })
    await tx.init()
    const { Command } = require('@cloudbase/database/dist/commonjs/command.js') as {
      Command: { in(values: string[]): unknown }
    }
    const ids = Array.from({ length: 15 }, (_, index) =>
      stableId('card', 'act_test', String(index + 1)),
    )
    await tx
      .collection('activity_cards')
      .where({ _id: Command.in(ids) })
      .limit(15)
      .get()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].action, 'database.getDocument')
    assert.equal(calls[1].params?.transactionId, 'test_tx')
    assert.equal(calls[1].params?.limit, 15)
    assert.equal(calls[1].params?.collectionName, 'activity_cards')
    assert.deepEqual(JSON.parse(String(calls[1].params?.query)), { _id: { $in: ids } })
  } finally {
    Db.reqClass = saved
  }
})
