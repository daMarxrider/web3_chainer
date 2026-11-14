import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addAccount,
  defaultSettings,
  executeQuote,
  findChain,
  findRoutes,
  listTransfers,
  loadKeystore,
  normalizeLifiQuote,
  rankQuotes,
  trackTransfer,
  unlock,
  type BridgeProvider,
  type Chain,
  type ChainAdapter,
  type LifiQuote,
  type Quote,
  type QuoteRequest,
  type Signer,
  type Store,
  type Token,
  type TransferStatus,
} from '../src/index.ts'

function memoryStore(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    keys: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)),
  }
}

const usdcArb: Token = { chainKey: 'arb', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6, priceUsd: 1 }
const usdcBase: Token = { chainKey: 'bas', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, priceUsd: 1 }
const request: QuoteRequest = { from: usdcArb, to: usdcBase, amount: 100_000_000n, fromAddress: '0xabc', toAddress: '0xabc', slippage: 0.005 }

const quote = (over: Partial<Quote>): Quote => ({
  provider: 'test',
  tool: 'a',
  request,
  toAmount: 99_000_000n,
  toAmountMin: 98_000_000n,
  toAmountUsd: 99,
  costUsd: 0,
  etaSeconds: 60,
  viaSymbols: ['USDC'],
  actions: [{ kind: 'evm-tx', chainKey: 'arb', to: '0x1', data: '0x', value: 0n }],
  statusRef: {},
  ...over,
})

const provider = (quotes: Quote[] | Error, statuses: TransferStatus[] = [], traits = { nonCustodial: true, needsApiKey: false }): BridgeProvider => ({
  name: 'test',
  traits,
  getQuotes: async () => {
    if (quotes instanceof Error) throw quotes
    return quotes
  },
  getStatus: async () => statuses.shift() ?? { state: 'pending' },
})

test('cheapest ranks by value after gas and fees, fastest by time', () => {
  const slowCheap = quote({ tool: 'slow', toAmountUsd: 99.8, costUsd: 0.1, etaSeconds: 900 })
  const fastPricey = quote({ tool: 'fast', toAmountUsd: 99.9, costUsd: 1.5, etaSeconds: 5 })
  assert.deepEqual(rankQuotes([fastPricey, slowCheap], 'cheapest').map((q) => q.tool), ['slow', 'fast'])
  assert.deepEqual(rankQuotes([slowCheap, fastPricey], 'fastest').map((q) => q.tool), ['fast', 'slow'])
})

test('ranking falls back to raw amounts when prices are unknown', () => {
  const noPrice = { ...request, to: { ...usdcBase, priceUsd: undefined } }
  const small = quote({ tool: 'small', request: noPrice, toAmountUsd: undefined, toAmount: 1n })
  const big = quote({ tool: 'big', request: noPrice, toAmountUsd: undefined, toAmount: 2n })
  assert.deepEqual(rankQuotes([small, big], 'cheapest').map((q) => q.tool), ['big', 'small'])
})

test('avoid list blocks destinations and routes through avoided tokens', async () => {
  const settings = { ...defaultSettings, avoidTokens: ['usdt'] }
  const viaUsdt = quote({ tool: 'bad', viaSymbols: ['USDC', 'USDT'] })
  const clean = quote({ tool: 'good' })
  const { quotes } = await findRoutes(request, [provider([viaUsdt, clean])], settings)
  assert.deepEqual(quotes.map((q) => q.tool), ['good'])

  const toUsdt = { ...request, to: { ...usdcBase, symbol: 'USDT' } }
  await assert.rejects(findRoutes(toUsdt, [provider([clean])], settings), /avoid/)
})

test('custodial providers are never asked; failing providers are reported, not fatal', async () => {
  const custodial = provider([quote({ tool: 'custodial' })], [], { nonCustodial: false, needsApiKey: false })
  const broken = provider(new Error('down'))
  const { quotes, errors } = await findRoutes(request, [custodial, broken, provider([quote({ tool: 'ok' })])], defaultSettings)
  assert.deepEqual(quotes.map((q) => q.tool), ['ok'])
  assert.deepEqual(errors, ['test: down'])
})

test('findChain accepts key, id, name, alias and unique partial name', () => {
  const chain = (key: string, id: number, name: string, testnet = false): Chain => ({ family: 'evm', key, id, name, nativeSymbol: 'ETH', rpcUrls: [], testnet })
  const chains = [chain('arb', 42161, 'Arbitrum'), chain('arbs', 421614, 'Arbitrum Sepolia Testnet', true), chain('opt', 10, 'OP Mainnet'), chain('bas', 8453, 'Base')]
  assert.equal(findChain(chains, 'arb').id, 42161)
  assert.equal(findChain(chains, '8453').key, 'bas')
  assert.equal(findChain(chains, 'Arbitrum').key, 'arb')
  assert.equal(findChain(chains, 'optimism').key, 'opt')
  assert.equal(findChain(chains, 'sepolia').key, 'arbs')
  assert.throws(() => findChain(chains, 'solana'), /Unknown chain/)
})

test('LI.FI quote: gas is extra cost, included fees are not counted twice, ERC-20 needs approval', () => {
  const lifi: LifiQuote = {
    tool: 'across',
    action: { fromToken: { ...usdcArb, chainId: 42161 }, toToken: { ...usdcBase, chainId: 8453 }, fromChainId: 42161, toChainId: 8453 },
    estimate: {
      approvalAddress: '0xspender',
      toAmount: '99750000',
      toAmountMin: '99250000',
      toAmountUSD: '99.75',
      executionDuration: 4,
      feeCosts: [{ amountUSD: '0.25', included: true }, { amountUSD: '0.40', included: false }],
      gasCosts: [{ amountUSD: '0.01' }],
    },
    includedSteps: [{ action: { fromToken: { ...usdcArb, chainId: 42161 }, toToken: { ...usdcBase, chainId: 8453, symbol: 'USDbC' } } }],
    transactionRequest: { to: '0xdiamond', data: '0xdead', value: '0x0', gasLimit: '0x5208' },
  }
  const q = normalizeLifiQuote(lifi, request)
  assert.equal(q.toAmount, 99_750_000n)
  assert.ok(Math.abs(q.costUsd - 0.41) < 1e-9)
  assert.deepEqual(q.viaSymbols, ['USDC', 'USDbC'])
  assert.deepEqual(q.actions[0], {
    kind: 'evm-tx',
    chainKey: 'arb',
    to: '0xdiamond',
    data: '0xdead',
    value: 0n,
    gasLimit: 21000n,
    approval: { token: usdcArb.address, spender: '0xspender', amount: 100_000_000n },
  })
  assert.deepEqual(q.statusRef, { tool: 'across', fromChain: 42161, toChain: 8453 })
})

test('keystore round-trips seeds and keys, rejects wrong passwords, stores no plaintext', async () => {
  const store = memoryStore()
  const mnemonic = 'test test test test test test test test test test test junk'
  const seed = await addAccount(store, 'main', `  ${mnemonic}  `, 'correct horse')
  assert.equal(seed.addresses.evm, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
  const key = await addAccount(store, 'imported', 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'correct horse')
  assert.equal(key.type, 'key')
  assert.equal(key.addresses.evm, seed.addresses.evm)

  assert.equal((await unlock(store, 'imported', 'correct horse')).evm.address, seed.addresses.evm)
  await assert.rejects(unlock(store, 'main', 'wrong password'), /Wrong password/)
  await assert.rejects(addAccount(store, 'third', mnemonic, 'another password'), /Wrong password/)
  await assert.rejects(addAccount(store, 'main', mnemonic, 'correct horse'), /already exists/)
  await assert.rejects(addAccount(store, 'bad', 'not a seed phrase', 'correct horse'), /Not a valid/)

  const raw = store.data.get('keystore.json')!
  assert.ok(!raw.includes('junk') && !raw.includes('ac0974bec'))
  assert.equal((await loadKeystore(store)).accounts.length, 2)
})

function fakeAdapter(log: string[], opts: { sendFails?: boolean; reverts?: boolean } = {}): ChainAdapter {
  return {
    chain: { family: 'evm', key: 'arb', id: 42161, name: 'Arbitrum', nativeSymbol: 'ETH', rpcUrls: [], testnet: false },
    validateAddress: () => true,
    getBalances: async (_, tokens) => tokens.map(() => 0n),
    prepare: async () => void log.push('prepare'),
    send: async () => {
      log.push('send')
      if (opts.sendFails) throw new Error('rpc timeout')
      return '0xhash'
    },
    waitForConfirmation: async () => !opts.reverts,
  }
}
const signer = {} as Signer

test('a transfer is journalled before signing and ends as done with the received amount', async () => {
  const store = memoryStore()
  const log: string[] = []
  const states: string[] = []
  const p = provider([], [{ state: 'pending', detail: 'bridging' }, { state: 'done', receivedAmount: 99_700_000n, destTxId: '0xdest' }])
  const record = await executeQuote(quote({}), 'main', signer, {
    store,
    provider: p,
    adapter: fakeAdapter(log),
    pollMs: 1,
    onEvent: (r) => states.push(r.state),
  })
  assert.deepEqual(log, ['prepare', 'send'])
  assert.equal(states[0], 'signing')
  assert.equal(record.state, 'done')
  assert.equal(record.receivedAmount, '99700000')
  assert.deepEqual((await listTransfers(store)).map((r) => [r.state, r.txId, r.destTxId]), [['done', '0xhash', '0xdest']])
})

test('an error while sending leaves the record as "signing" so it is never re-sent blindly', async () => {
  const store = memoryStore()
  const deps = { store, provider: provider([]), adapter: fakeAdapter([], { sendFails: true }), pollMs: 1, onEvent: () => {} }
  await assert.rejects(executeQuote(quote({}), 'main', signer, deps), /rpc timeout/)
  const [record] = await listTransfers(store)
  assert.equal(record!.state, 'signing')
  assert.equal(record!.txId, undefined)
})

test('a submitted transfer can be picked up again after a restart; a revert is reported as failed', async () => {
  const store = memoryStore()
  const deps = { store, provider: provider([], [{ state: 'done' }]), adapter: fakeAdapter([]), pollMs: 1, onEvent: () => {} }
  const done = await executeQuote(quote({}), 'main', signer, deps)
  const resumed = await trackTransfer({ ...done, state: 'submitted' }, { ...deps, provider: provider([], [{ state: 'done', receivedAmount: 5n }]) })
  assert.equal(resumed.state, 'done')
  assert.equal(resumed.receivedAmount, '5')

  const reverted = await trackTransfer({ ...done, state: 'submitted' }, { ...deps, adapter: fakeAdapter([], { reverts: true }) })
  assert.equal(reverted.state, 'failed')
  assert.match(reverted.error!, /reverted/)
})
