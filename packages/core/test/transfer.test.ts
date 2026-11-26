import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeQuote, getTransfer, listTransfers, trackTransfer, type Action, type BridgeProvider, type ChainAdapter, type Quote, type Signer, type Store, type TransferDeps, type TransferRecord, type TransferStatus } from '../src/index.ts'

// ---- fixtures ----

function memoryStore(): Store {
  const data = new Map<string, string>()
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async (p) => [...data.keys()].filter((k) => k.startsWith(p)) }
}
const usdcArb = { chainKey: 'arb', address: '0xa', symbol: 'USDC', decimals: 6 }
const usdcBase = { chainKey: 'bas', address: '0xb', symbol: 'USDC', decimals: 6 }
const quote: Quote = { provider: 'fake', tool: 'bridge', request: { from: usdcArb, to: usdcBase, amount: 1_000_000n, fromAddress: '0xme', toAddress: '0xme', slippage: 0.005 }, toAmount: 990_000n, toAmountMin: 980_000n, costUsd: 0.1, etaSeconds: 60, viaSymbols: [], raw: null, statusRef: { ref: 1 } }
const signer = {} as Signer
const tx = (n: number): Action => ({ kind: 'evm-tx', chainKey: 'arb', to: `0x${n}`, data: '0x', value: 0n })

/** A provider whose status answers come from the list in turn (the last one repeats). */
function provider(statuses: TransferStatus[], actions: Action[] = [tx(1)], extra: Partial<BridgeProvider> = {}): BridgeProvider {
  let i = 0
  return { name: 'fake', traits: { nonCustodial: true, needsApiKey: false }, getQuotes: async () => [], buildActions: async () => actions, getStatus: async () => statuses[Math.min(i++, statuses.length - 1)]!, ...extra }
}
/** A chain adapter that records what it sends; `fail` makes one step throw. */
function adapter(opts: { fail?: 'prepare' | 'send'; confirmed?: boolean } = {}) {
  const sent: Action[] = []
  const a: ChainAdapter = {
    chain: { family: 'evm', key: 'arb', id: 42161, name: 'Arbitrum', nativeSymbol: 'ETH', rpcUrls: [], testnet: false },
    validateAddress: () => true,
    getBalances: async () => [],
    prepare: async () => {
      if (opts.fail === 'prepare') throw new Error('Token approval reverted (0xdead)')
    },
    send: async (action) => {
      if (opts.fail === 'send') throw new Error('nonce too low')
      sent.push(action)
      return `0xtx${sent.length}`
    },
    waitForConfirmation: async () => opts.confirmed ?? true,
  }
  return { a, sent }
}
function deps(p: BridgeProvider, ad: ChainAdapter, extra: Partial<TransferDeps> = {}) {
  const events: string[] = []
  const d: TransferDeps = { store: memoryStore(), provider: p, adapter: ad, onEvent: (_r, m) => events.push(m), pollMs: 0, ...extra }
  return { d, events }
}
const done: TransferStatus = { state: 'done', receivedAmount: 990_500n, destTxId: '0xdest' }

// ---- sending ----

test('a transfer is saved under the id the caller chose', async () => {
  const { d } = deps(provider([done]), adapter().a, { id: 'my-id' })
  await executeQuote(quote, 'main', signer, d)
  assert.equal((await getTransfer(d.store, 'my-id'))?.state, 'done')
})

test('every action of a route is sent in order', async () => {
  const ad = adapter()
  await executeQuote(quote, 'main', signer, deps(provider([done], [tx(1), tx(2)]), ad.a).d)
  assert.deepEqual(ad.sent.map((a) => (a as { to: string }).to), ['0x1', '0x2'])
})

test('a transfer whose approval fails is failed, as nothing left the wallet', async () => {
  const { d } = deps(provider([done]), adapter({ fail: 'prepare' }).a, { id: 't' })
  await assert.rejects(executeQuote(quote, 'main', signer, d), /Token approval reverted/)
  const r = await getTransfer(d.store, 't')
  assert.deepEqual([r?.state, r?.error], ['failed', 'Token approval reverted (0xdead)'])
})

test('a transfer whose building fails is failed', async () => {
  const p = provider([done], [], { buildActions: async () => { throw new Error('LI.FI returned no transaction for this route') } })
  const { d } = deps(p, adapter().a, { id: 't' })
  await assert.rejects(executeQuote(quote, 'main', signer, d))
  assert.equal((await getTransfer(d.store, 't'))?.state, 'failed')
})

test('a transfer that fails while sending stays "signing", since the node may have taken it', async () => {
  const { d } = deps(provider([done]), adapter({ fail: 'send' }).a, { id: 't' })
  await assert.rejects(executeQuote(quote, 'main', signer, d), /nonce too low/)
  const r = await getTransfer(d.store, 't')
  assert.deepEqual([r?.state, r?.error], ['signing', 'nonce too low'])
})

test('a transaction that reverts on the source chain fails the transfer and says the funds stayed', async () => {
  const { d } = deps(provider([done]), adapter({ confirmed: false }).a)
  const r = await executeQuote(quote, 'main', signer, d)
  assert.deepEqual([r.state, r.error], ['failed', 'The transaction reverted on the source chain; the funds did not leave the wallet'])
})

// ---- following the bridge ----

test('a done transfer records the exact amount received and the destination transaction', async () => {
  const r = await executeQuote(quote, 'main', signer, deps(provider([done]), adapter().a).d)
  assert.deepEqual([r.state, r.receivedAmount, r.destTxId], ['done', '990500', '0xdest'])
})

test('a bridge’s pending message is shown once, however often it repeats', async () => {
  const waiting: TransferStatus = { state: 'pending', detail: 'Waiting for the bridge' }
  const { d, events } = deps(provider([waiting, waiting, waiting, done]), adapter().a)
  await executeQuote(quote, 'main', signer, d)
  assert.equal(events.filter((e) => e === 'Waiting for the bridge').length, 1)
})

test('a new pending message is shown when it changes', async () => {
  const { d, events } = deps(provider([{ state: 'pending', detail: 'A' }, { state: 'pending', detail: 'B' }, { state: 'pending', detail: 'A' }, done]), adapter().a)
  await executeQuote(quote, 'main', signer, d)
  assert.deepEqual(events.filter((e) => e === 'A' || e === 'B'), ['A', 'B', 'A'])
})

test('a failed bridge without a reason is recorded with a general one', async () => {
  const r = await executeQuote(quote, 'main', signer, deps(provider([{ state: 'failed' }]), adapter().a).d)
  assert.deepEqual([r.state, r.error], ['failed', 'The bridge reported a failure'])
})

test('a failed bridge’s own reason is kept', async () => {
  const r = await executeQuote(quote, 'main', signer, deps(provider([{ state: 'failed', detail: 'Refunded' }]), adapter().a).d)
  assert.equal(r.error, 'Refunded')
})

test('a done transfer without an amount leaves the amount unknown', async () => {
  const r = await executeQuote(quote, 'main', signer, deps(provider([{ state: 'done' }]), adapter().a).d)
  assert.equal(r.receivedAmount, undefined)
})

test('a record that was never submitted is not tracked', async () => {
  const p = provider([done], [], { getStatus: async () => { throw new Error('must not be asked') } })
  const created = { state: 'created', txId: undefined } as unknown as TransferRecord
  assert.equal(await trackTransfer(created, deps(p, adapter().a).d), created)
})

test('a submitted record without a transaction id is not tracked', async () => {
  const p = provider([done], [], { getStatus: async () => { throw new Error('must not be asked') } })
  const odd = { state: 'submitted' } as unknown as TransferRecord
  assert.equal((await trackTransfer(odd, deps(p, adapter().a).d)).state, 'submitted')
})

// ---- providers that run the whole transfer themselves ----

test('a self-driving provider without the wallet signer and chains is refused, and nothing moved', async () => {
  const p = provider([done], [], { run: async () => done })
  const { d } = deps(p, adapter().a, { id: 't' })
  await assert.rejects(executeQuote(quote, 'main', signer, d), /^Error: fake runs the whole transfer itself and needs the wallet signer and chain access$/)
  assert.equal((await getTransfer(d.store, 't'))?.state, 'failed')
})

const selfDriving = (run: BridgeProvider['run'], resume?: BridgeProvider['resume']) => provider([done], [], { run, resume })
const withChains = (ad: ChainAdapter) => ({ signer, adapterFor: () => ad })

test('a self-driving run that fails before sending anything is failed', async () => {
  const ad = adapter().a
  const { d } = deps(selfDriving(async () => { throw new Error('LP unreachable') }), ad, { id: 't', ...withChains(ad) })
  await assert.rejects(executeQuote(quote, 'main', signer, d))
  assert.equal((await getTransfer(d.store, 't'))?.state, 'failed')
})

test('a self-driving run that fails after its first transaction stays submitted, so it can be resumed', async () => {
  const ad = adapter().a
  const run: BridgeProvider['run'] = async (_q, ctx) => {
    await ctx.checkpoint({ txId: '0xcommit', state: { step: 'committed' } })
    throw new Error('connection lost')
  }
  const { d } = deps(selfDriving(run), ad, { id: 't', ...withChains(ad) })
  await assert.rejects(executeQuote(quote, 'main', signer, d))
  const r = await getTransfer(d.store, 't')
  assert.deepEqual([r?.state, r?.txId, r?.providerState, r?.error], ['submitted', '0xcommit', { step: 'committed' }, 'connection lost'])
})

test('a self-driving run still pending at its end is left submitted', async () => {
  const ad = adapter().a
  const { d } = deps(selfDriving(async () => ({ state: 'pending' })), ad, withChains(ad))
  assert.equal((await executeQuote(quote, 'main', signer, d)).state, 'submitted')
})

test('a self-driving run that failed without a reason is recorded with a general one', async () => {
  const ad = adapter().a
  const { d } = deps(selfDriving(async () => ({ state: 'failed' })), ad, withChains(ad))
  assert.equal((await executeQuote(quote, 'main', signer, d)).error, 'The swap failed')
})

const interrupted = (): TransferRecord => ({ id: 'r', createdAt: '2026-11-26T00:00:00Z', wallet: 'main', provider: 'fake', tool: 'swap', from: usdcArb, to: usdcBase, amount: '1', expectedAmount: '1', fromAddress: '0xme', toAddress: '0xme', statusRef: {}, state: 'submitted', txId: '0xcommit', providerState: { step: 'committed' } })

test('an interrupted self-driving run is resumed by its provider with its saved state', async () => {
  const ad = adapter().a
  let seen: unknown
  const { d } = deps(selfDriving(async () => done, async (ctx) => ((seen = ctx.state), done)), ad, withChains(ad))
  const r = await trackTransfer(interrupted(), d)
  assert.deepEqual([r.state, seen], ['done', { step: 'committed' }])
})

test('a resume that fails keeps the reason and lets the error through', async () => {
  const ad = adapter().a
  const { d } = deps(selfDriving(async () => done, async () => { throw new Error('swap expired') }), ad, withChains(ad))
  const record = interrupted()
  await assert.rejects(trackTransfer(record, d), /^Error: swap expired$/)
  assert.deepEqual([record.state, record.error], ['submitted', 'swap expired'])
})

// ---- the journal ----

test('a transfer id never written reads as nothing', async () => {
  assert.equal(await getTransfer(memoryStore(), 'nope'), null)
})

test('the journal lists transfers oldest first', async () => {
  const store = memoryStore()
  await store.set('journal/b.json', JSON.stringify({ id: 'b', createdAt: '2026-11-26T10:00:00Z' }))
  await store.set('journal/a.json', JSON.stringify({ id: 'a', createdAt: '2026-11-25T10:00:00Z' }))
  assert.deepEqual((await listTransfers(store)).map((r) => r.id), ['a', 'b'])
})
