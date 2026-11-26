import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { atomiqProvider, executeQuote, type Action, type Chain, type ChainAdapter, type QuoteRequest, type Signer, type Store, type Token } from '../src/index.ts'

const memory = (): Store => {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)) }
}
const chains: Chain[] = [
  { family: 'bitcoin', key: 'btc', id: 1, name: 'Bitcoin', nativeSymbol: 'BTC', rpcUrls: [], testnet: false },
  { family: 'solana', key: 'sol', id: 2, name: 'Solana', nativeSymbol: 'SOL', rpcUrls: ['http://sol'], testnet: false },
]
const BTC: Token = { chainKey: 'btc', address: 'bitcoin', symbol: 'BTC', decimals: 8 }
const SOL: Token = { chainKey: 'sol', address: '11111111111111111111111111111111', symbol: 'SOL', decimals: 9 }
const USDC: Token = { chainKey: 'sol', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 }
const signer = { evm: {} as never, seed: new Uint8Array(64).fill(7) } as Signer
const request = (from: Token, to: Token): QuoteRequest => ({ from, to, amount: 100_000n, fromAddress: 'src', toAddress: 'dst', slippage: 0.01 })

/** A fake swap that records what was called, with the SDK's state numbers. */
function fakeSwap(kind: 'tobtc' | 'frombtc', opts: { paid?: boolean; settled?: boolean } = {}) {
  const log: string[] = []
  let state = 0
  const swap: any = {
    log,
    getId: () => 'swap1',
    getState: () => state,
    getOutput: () => ({ rawAmount: 1234n }),
    getInput: () => ({ rawAmount: 100_000n }),
    getAddress: () => 'bc1qswapaddress',
    getTimeoutTime: () => Date.now() + 3_600_000,
    getOutputTxId: () => 'outtx',
    getClaimerBounty: () => ({ usdValue: async () => 0.5 }),
    getSmartChainNetworkFee: async () => ({ usdValue: async () => 0.01 }),
    isSuccessful: () => state === 3 && (kind === 'frombtc' || opts.paid !== false),
    isFailed: () => false,
    isFinished: () => state === 3,
    isRefundable: () => kind === 'tobtc' && state === 4,
    async commit(_w: unknown, _a: unknown, _s: unknown, before: (id: string) => void) { log.push('commit'); before('committx'); state = 1; return 'committx' },
    async waitTillCommited() { log.push('waitCommitted') },
    async waitForPayment() { log.push('waitForPayment'); state = opts.paid === false ? 4 : 3; return opts.paid !== false },
    async refund() { log.push('refund'); state = 0 },
    async waitForBitcoinTransaction() { log.push('waitBtc'); state = 2; return 'btctx' },
    async waitTillClaimed() { log.push('waitClaimed'); if (opts.settled !== false) state = 3; return opts.settled !== false },
    async claim() { log.push('claim'); state = 3 },
  }
  return swap
}

async function setup(swap: any) {
  const created: unknown[][] = []
  const sdk = {
    BitcoinNetwork: { MAINNET: 'main', TESTNET4: 't4' },
    SwapAmountType: { EXACT_IN: 1 },
    ToBTCSwapState: { CREATED: 0 },
    FromBTCSwapState: { PR_CREATED: 0, CLAIM_COMMITED: 1, BTC_TX_CONFIRMED: 2, CLAIM_CLAIMED: 3, EXPIRED: -3, FAILED: -4 },
    SwapperFactory: class {
      Tokens = { BITCOIN: { BTC: 'BTC' }, SOLANA: { SOL: 'SOL' } }
      newSwapper() {
        return { init: async () => {}, swap: async (...args: unknown[]) => (created.push(args), swap), getSwapById: async () => swap }
      }
    },
  }
  const modules: Record<string, unknown> = {
    '@atomiqlabs/sdk': sdk,
    '@atomiqlabs/chain-solana': { SolanaInitializer: {}, SolanaKeypairWallet: class { payer: unknown; constructor(payer: unknown) { this.payer = payer } } },
    '@solana/web3.js': { Connection: class {}, Keypair: { fromSeed: (s: Uint8Array) => ({ seed: s }) } },
  }
  const provider = (await atomiqProvider(fetch, chains, { dir: await mkdtemp(join(tmpdir(), 'atomiq-')), testnet: false, load: async (p) => modules[p] }))!
  const sent: Action[] = []
  const adapter = { send: async (a: Action) => (sent.push(a), 'btcsendtx') } as unknown as ChainAdapter
  const deps = { store: memory(), provider, adapter, adapterFor: () => adapter, signer, onEvent: () => {} }
  return { provider, created, sent, deps }
}

test('without the optional packages there is no provider', async () => {
  const none = async (pkg: string) => { throw Object.assign(new Error(`Cannot find package '${pkg}'`), { code: 'ERR_MODULE_NOT_FOUND' }) }
  assert.equal(await atomiqProvider(fetch, chains, { dir: tmpdir(), testnet: false, load: none }), undefined)
})

test('only native BTC <-> native SOL is quoted', async () => {
  const { provider, created } = await setup(fakeSwap('tobtc'))
  assert.deepEqual(await provider.getQuotes(request(USDC, BTC), 'cheapest'), [])
  assert.deepEqual(await provider.getQuotes(request(BTC, USDC), 'cheapest'), [])
  assert.equal(created.length, 0)
  const [q] = await provider.getQuotes(request(SOL, BTC), 'cheapest')
  assert.deepEqual([q!.tool, q!.toAmount, q!.toAmountMin], ['atomiq-sol-btc', 1234n, 1234n])
  // exact-in, source address given for a Solana source
  assert.deepEqual(created[0]!.slice(2), [100_000n, 1, 'src', 'dst'])
})

test('SOL -> BTC: commit, wait for the payout, done', async () => {
  const swap = fakeSwap('tobtc')
  const { provider, deps } = await setup(swap)
  const [q] = await provider.getQuotes(request(SOL, BTC), 'cheapest')
  const rec = await executeQuote(q!, 'w', signer, deps)
  assert.deepEqual([rec.state, rec.txId, rec.destTxId, rec.receivedAmount], ['done', 'committx', 'outtx', '1234'])
  assert.deepEqual(swap.log, ['commit', 'waitCommitted', 'waitForPayment'])
})

test('SOL -> BTC: when the LP does not pay, the wallet refunds itself and the transfer fails', async () => {
  const swap = fakeSwap('tobtc', { paid: false })
  const { provider, deps } = await setup(swap)
  const [q] = await provider.getQuotes(request(SOL, BTC), 'cheapest')
  const rec = await executeQuote(q!, 'w', signer, deps)
  assert.equal(rec.state, 'failed')
  assert.match(rec.error!, /refunded/)
  assert.ok(swap.log.includes('refund'))
})

test('BTC -> SOL: open the address, pay exactly the quoted sats, wait, claim by hand if no watchtower does', async () => {
  const swap = fakeSwap('frombtc', { settled: false })
  const { provider, deps, sent } = await setup(swap)
  const [q] = await provider.getQuotes(request(BTC, SOL), 'cheapest')
  const rec = await executeQuote(q!, 'w', signer, deps)
  assert.equal(rec.state, 'done')
  assert.deepEqual(sent, [{ kind: 'utxo-send', chainKey: 'btc', to: 'bc1qswapaddress', amount: 100_000n }])
  assert.deepEqual(swap.log, ['commit', 'waitCommitted', 'waitBtc', 'waitClaimed', 'claim'])
  assert.equal(rec.providerState?.btcTx, 'btcsendtx')
})

test('BTC -> SOL resume after the Bitcoin was sent does not send it again', async () => {
  const swap = fakeSwap('frombtc')
  const { provider, deps, sent } = await setup(swap)
  swap.commit = async () => 'x'
  const ctxState = { swapId: 'swap1', dir: 'frombtc', btcTx: 'already' }
  // swap is already past opening: state CLAIM_COMMITED
  ;(swap as any).getState = (() => { let s = 1; swap.waitForBitcoinTransaction = async () => (s = 2, 'btctx'); swap.waitTillClaimed = async () => (s = 3, true); return () => s })()
  swap.isSuccessful = () => swap.getState() === 3
  const status = await provider.resume!({ signer, adapterFor: deps.adapterFor, state: ctxState, checkpoint: async () => {}, say: () => {} })
  assert.equal(status.state, 'done')
  assert.equal(sent.length, 0)
})

test('a quote whose network fee cannot be priced is refused with the reason, not offered as free', async () => {
  const swap = fakeSwap('tobtc')
  swap.getSmartChainNetworkFee = async () => ({ usdValue: async () => { throw new Error('price feed down') } })
  const { provider } = await setup(swap)
  await assert.rejects(provider.getQuotes(request(SOL, BTC), 'cheapest'), /^Error: Atomiq could not price the Solana network fee \(price feed down\), so the route's cost is unknown$/)
})

test('a quote from Bitcoin whose watchtower fee cannot be priced is refused with the reason', async () => {
  const swap = fakeSwap('frombtc')
  swap.getClaimerBounty = () => ({ usdValue: async () => { throw new Error('price feed down') } })
  const { provider } = await setup(swap)
  await assert.rejects(provider.getQuotes(request(BTC, SOL), 'cheapest'), /^Error: Atomiq could not price the watchtower fee \(price feed down\), so the route's cost is unknown$/)
})

test('a quote to Bitcoin costs the Solana network fee in dollars', async () => {
  const { provider } = await setup(fakeSwap('tobtc'))
  const [q] = await provider.getQuotes(request(SOL, BTC), 'cheapest')
  assert.equal(q!.costUsd, 0.01)
})

test('a quote from Bitcoin costs the watchtower fee in dollars', async () => {
  const { provider } = await setup(fakeSwap('frombtc'))
  const [q] = await provider.getQuotes(request(BTC, SOL), 'cheapest')
  assert.equal(q!.costUsd, 0.5)
})

test('a quote from Bitcoin without a watchtower fee costs nothing extra', async () => {
  const swap = fakeSwap('frombtc')
  swap.getClaimerBounty = () => undefined
  const { provider } = await setup(swap)
  const [q] = await provider.getQuotes(request(BTC, SOL), 'cheapest')
  assert.equal(q!.costUsd, 0)
})
