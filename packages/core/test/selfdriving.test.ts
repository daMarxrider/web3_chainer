import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeQuote, getTransfer, trackTransfer, type BridgeProvider, type ChainAdapter, type Quote, type Signer, type Store, type Token } from '../src/index.ts'

const memory = (): Store => {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)) }
}
const token = (chainKey: string): Token => ({ chainKey, address: 'x', symbol: 'T', decimals: 8 })
const quote = (): Quote => ({
  provider: 'fake', tool: 'fake', toAmount: 90n, toAmountMin: 90n, costUsd: 0, etaSeconds: 1, viaSymbols: [], raw: {}, statusRef: {},
  request: { from: token('btc'), to: token('sol'), amount: 100n, fromAddress: 'a', toAddress: 'b', slippage: 0 },
})
const signer = {} as Signer
const adapter = {} as ChainAdapter

/** Crashes once after the first checkpoint, then finishes on resume. */
function fakeProvider(crash: boolean) {
  const calls: string[] = []
  const provider: BridgeProvider = {
    name: 'fake',
    traits: { nonCustodial: true, needsApiKey: false },
    getQuotes: async () => [],
    buildActions: async () => { throw new Error('self-driving providers never build actions') },
    getStatus: async () => { throw new Error('never polled') },
    async run(_q, ctx) {
      calls.push('run')
      await ctx.checkpoint({ txId: '0xcommit', state: { swapId: 'abc', step: 'opened' } })
      if (crash) throw new Error('power cut')
      return { state: 'done', destTxId: '0xclaim', receivedAmount: 90n }
    },
    async resume(ctx) {
      calls.push(`resume:${JSON.stringify(ctx.state)}`)
      return { state: 'done', destTxId: '0xclaim', receivedAmount: 90n }
    },
  }
  return { provider, calls }
}

test('a self-driving run finishes without buildActions or polling', async () => {
  const store = memory()
  const { provider } = fakeProvider(false)
  const record = await executeQuote(quote(), 'w', signer, { store, provider, adapter, adapterFor: () => adapter, signer, onEvent: () => {} })
  assert.deepEqual([record.state, record.txId, record.destTxId, record.receivedAmount], ['done', '0xcommit', '0xclaim', '90'])
})

test('a crash after the first txId leaves a resumable record, and resume uses the saved state', async () => {
  const store = memory()
  const { provider, calls } = fakeProvider(true)
  const deps = { store, provider, adapter, adapterFor: () => adapter, signer, onEvent: () => {}, id: 'r1' }
  await assert.rejects(executeQuote(quote(), 'w', signer, deps), /power cut/)
  const saved = (await getTransfer(store, 'r1'))!
  assert.equal(saved.state, 'submitted')
  assert.deepEqual(saved.providerState, { swapId: 'abc', step: 'opened' })

  const done = await trackTransfer(saved, deps)
  assert.equal(done.state, 'done')
  assert.deepEqual(calls, ['run', 'resume:{"swapId":"abc","step":"opened"}'])
})

test('a failure before the first txId is a plain failure: nothing left the wallet', async () => {
  const store = memory()
  const { provider } = fakeProvider(false)
  provider.run = async () => { throw new Error('LP refused the quote') }
  const deps = { store, provider, adapter, adapterFor: () => adapter, signer, onEvent: () => {}, id: 'r2' }
  await assert.rejects(executeQuote(quote(), 'w', signer, deps), /LP refused/)
  assert.equal((await getTransfer(store, 'r2'))!.state, 'failed')
})
