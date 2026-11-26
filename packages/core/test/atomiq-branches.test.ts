import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { atomiqProvider, type Action, type Chain, type ChainAdapter, type Quote, type RunContext, type Signer, type Token } from '../src/index.ts'

// ---- a fake Atomiq SDK ----

const ToBTC = { CREATED: 0, COMMITED: 1, SOFT_CLAIMED: 2, CLAIMED: 3, REFUNDABLE: 4 }
const FromBTC = { PR_CREATED: 0, CLAIM_COMMITED: 1, BTC_TX_CONFIRMED: 2, CLAIM_CLAIMED: 3, EXPIRED: -3, FAILED: -4 }

/** A swap in a given state whose behaviour each test sets. */
function swap(opts: { state: number; successful?: boolean | (() => boolean); refundable?: boolean; failed?: boolean; finished?: boolean; paid?: boolean; outputTx?: string | null; timeout?: number; afterBtcWait?: number; claimed?: boolean }) {
  let state = opts.state
  const log: string[] = []
  const s = {
    log,
    getId: () => 'swap-1',
    getState: () => state,
    getOutput: () => ({ rawAmount: 777n }),
    getInput: () => ({ rawAmount: 50_000n }),
    getAddress: () => 'bc1qswapaddress',
    getTimeoutTime: () => opts.timeout ?? Date.now() + 3_600_000,
    getOutputTxId: () => (opts.outputTx === undefined ? 'out-tx' : opts.outputTx),
    isSuccessful: () => (typeof opts.successful === 'function' ? opts.successful() : !!opts.successful),
    isRefundable: () => !!opts.refundable,
    isFailed: () => !!opts.failed,
    isFinished: () => !!opts.finished,
    async waitForPayment() {
      log.push('waitForPayment')
      return !!opts.paid
    },
    async waitForBitcoinTransaction(progress: (txId?: string, c?: number, t?: number) => void) {
      log.push('waitBtc')
      progress('btc-in', 1, 3)
      progress(undefined, 2, 3)
      progress('btc-in', undefined, undefined)
      state = opts.afterBtcWait ?? FromBTC.BTC_TX_CONFIRMED
    },
    async waitTillClaimed() {
      log.push('waitClaimed')
      return opts.claimed ?? true
    },
    async claim() {
      log.push('claim')
    },
    async refund() {
      log.push('refund')
    },
    async commit(_w: unknown, _a: unknown, _s: unknown, before: (id: string) => void) {
      before('commit-tx')
      state = state === FromBTC.PR_CREATED ? FromBTC.CLAIM_COMMITED : ToBTC.COMMITED
    },
    async waitTillCommited() {},
  }
  return s
}

/** Loads the provider with the fake SDK; records what the SDK was set up with. */
async function provider(t: { after: (fn: () => Promise<void>) => void }, opts: { testnet?: boolean; chains?: Chain[]; solanaRpc?: string; stored?: unknown } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'atomiq-branches-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const seen: { rpc?: string; network?: string } = {}
  const sdk = {
    BitcoinNetwork: { MAINNET: 'main', TESTNET4: 'testnet4' },
    SwapAmountType: { EXACT_IN: 1 },
    ToBTCSwapState: ToBTC,
    FromBTCSwapState: FromBTC,
    SwapperFactory: class {
      Tokens = { BITCOIN: { BTC: 'BTC' }, SOLANA: { SOL: 'SOL' } }
      newSwapper(config: { chains: { SOLANA: { rpcUrl: { url: string } } }; bitcoinNetwork: string }) {
        seen.rpc = config.chains.SOLANA.rpcUrl.url
        seen.network = config.bitcoinNetwork
        return { init: async () => {}, getSwapById: async () => opts.stored }
      }
    },
  }
  const modules: Record<string, unknown> = {
    '@atomiqlabs/sdk': sdk,
    '@atomiqlabs/chain-solana': { SolanaInitializer: {}, SolanaKeypairWallet: class {} },
    '@solana/web3.js': {
      Connection: class {
        url: string
        constructor(url: string) {
          this.url = url
        }
      },
      Keypair: { fromSeed: () => ({}) },
    },
  }
  const p = (await atomiqProvider(fetch, opts.chains ?? [], { dir, testnet: !!opts.testnet, solanaRpc: opts.solanaRpc, load: async (pkg) => modules[pkg] }))!
  return { p, seen, dir }
}

const seeded: Signer = { evm: {} as never, seed: new Uint8Array(64).fill(7) }
/** A run context recording what the swap said and saved, with a Bitcoin chain that records sends. */
function context(state?: Record<string, unknown>, signer: Signer = seeded) {
  const said: string[] = []
  const saved: { txId?: string; state?: Record<string, unknown> }[] = []
  const sent: Action[] = []
  const btc = { send: async (a: Action) => (sent.push(a), 'btc-tx') } as unknown as ChainAdapter
  const ctx: RunContext = { signer, adapterFor: () => btc, state, say: (m) => said.push(m), checkpoint: async (p) => void saved.push(p) }
  return { ctx, said, saved, sent }
}
const quoteFor = (s: ReturnType<typeof swap>, dir: 'tobtc' | 'frombtc'): Quote => ({ raw: { swap: s }, statusRef: { dir } }) as unknown as Quote

// ---- setup ----

test('on test networks the SDK uses Bitcoin testnet4', async (t) => {
  const { p, seen } = await provider(t, { testnet: true, stored: swap({ state: ToBTC.CLAIMED, successful: true }) })
  await p.resume!(context({ swapId: 'swap-1', dir: 'tobtc' }).ctx)
  assert.equal(seen.network, 'testnet4')
})

test('on test networks swap data is kept in its own testnet4 folder', async (t) => {
  const { p, dir } = await provider(t, { testnet: true, stored: swap({ state: ToBTC.CLAIMED, successful: true }) })
  await p.resume!(context({ swapId: 'swap-1', dir: 'tobtc' }).ctx)
  assert.deepEqual(await readdir(join(dir, 'atomiq')), ['testnet4'])
})

test('on test networks without a Solana devnet endpoint, the public devnet is used', async (t) => {
  const { p, seen } = await provider(t, { testnet: true, stored: swap({ state: ToBTC.CLAIMED, successful: true }) })
  await p.resume!(context({ swapId: 'swap-1', dir: 'tobtc' }).ctx)
  assert.equal(seen.rpc, 'https://api.devnet.solana.com')
})

test('on main networks without a Solana endpoint, the public mainnet one is used', async (t) => {
  const { p, seen } = await provider(t, { stored: swap({ state: ToBTC.CLAIMED, successful: true }) })
  await p.resume!(context({ swapId: 'swap-1', dir: 'tobtc' }).ctx)
  assert.equal(seen.rpc, 'https://api.mainnet-beta.solana.com')
})

test('a Solana endpoint given to the provider wins over the chain’s own', async (t) => {
  const sol = { family: 'solana', key: 'sol', id: 1, name: 'Solana', nativeSymbol: 'SOL', rpcUrls: ['https://chain.rpc'], testnet: false } as Chain
  const { p, seen } = await provider(t, { chains: [sol], solanaRpc: 'https://mine.rpc', stored: swap({ state: ToBTC.CLAIMED, successful: true }) })
  await p.resume!(context({ swapId: 'swap-1', dir: 'tobtc' }).ctx)
  assert.equal(seen.rpc, 'https://mine.rpc')
})

test('a swap is refused for a wallet without a seed phrase', async (t) => {
  const { p } = await provider(t)
  await assert.rejects(p.run!(quoteFor(swap({ state: ToBTC.CREATED }), 'tobtc'), context(undefined, { evm: {} as never }).ctx), /^Error: Atomiq needs a wallet made from a seed phrase \(Solana key\)$/)
})

test('Atomiq swaps cannot be built as plain transactions', async (t) => {
  const { p } = await provider(t)
  await assert.rejects(p.buildActions!({} as Quote), /^Error: Atomiq runs the whole swap itself$/)
})

test('Atomiq swaps cannot be followed by polling', async (t) => {
  const { p } = await provider(t)
  await assert.rejects(p.getStatus('x', {}), /^Error: Atomiq swaps are followed by the swap run, not by polling$/)
})

// ---- SOL -> BTC ----

test('a swap the provider already paid out is done at once, with the payout transaction', async (t) => {
  const { p } = await provider(t)
  const result = await p.run!(quoteFor(swap({ state: ToBTC.CLAIMED, successful: true }), 'tobtc'), context().ctx)
  assert.deepEqual(result, { state: 'done', destTxId: 'out-tx', receivedAmount: 777n })
})

test('a payout without a transaction id leaves the destination transaction unknown', async (t) => {
  const { p } = await provider(t)
  const result = await p.run!(quoteFor(swap({ state: ToBTC.CLAIMED, successful: true, outputTx: null }), 'tobtc'), context().ctx)
  assert.equal(result.destTxId, undefined)
})

test('a swap paid out while waiting is done with the amount', async (t) => {
  const { p } = await provider(t)
  const result = await p.run!(quoteFor(swap({ state: ToBTC.COMMITED, paid: true }), 'tobtc'), context().ctx)
  assert.deepEqual(result, { state: 'done', destTxId: 'out-tx', receivedAmount: 777n })
})

test('a swap that finished without payout and without a refund is failed with the reason', async (t) => {
  const { p } = await provider(t)
  const result = await p.run!(quoteFor(swap({ state: ToBTC.COMMITED, finished: true }), 'tobtc'), context().ctx)
  assert.deepEqual(result, { state: 'failed', detail: 'The swap ended without a payout' })
})

test('a swap that turned out successful after a failed wait is done, without the amount', async (t) => {
  let checks = 0
  const s = swap({ state: ToBTC.COMMITED, paid: false, successful: () => ++checks > 1 })
  const { p } = await provider(t)
  assert.deepEqual(await p.run!(quoteFor(s, 'tobtc'), context().ctx), { state: 'done', destTxId: 'out-tx' })
})

// ---- BTC -> SOL ----

test('a swap address about to expire is not paid into, and nothing is sent', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-26T12:00:00Z') })
  try {
    const { p } = await provider(t)
    const c = context()
    // The address expires in 4 minutes; the margin is 5.
    const s = swap({ state: FromBTC.CLAIM_COMMITED, timeout: Date.now() + 4 * 60_000 })
    await assert.rejects(p.run!(quoteFor(s, 'frombtc'), c.ctx), /^Error: The swap address is about to expire; no Bitcoin was sent\. The deposit is released when the swap expires\.$/)
    assert.equal(c.sent.length, 0)
  } finally {
    mock.timers.reset()
  }
})

test('a swap whose Bitcoin was already sent is not paid into again', async (t) => {
  const { p } = await provider(t)
  const c = context({ btcTx: 'earlier' })
  await p.run!(quoteFor(swap({ state: FromBTC.CLAIM_COMMITED, successful: true }), 'frombtc'), c.ctx)
  assert.equal(c.sent.length, 0)
})

test('Bitcoin confirmations are reported only while the transaction is known, with unknown counts shown as 0 and ?', async (t) => {
  const { p } = await provider(t)
  const c = context()
  await p.run!(quoteFor(swap({ state: FromBTC.CLAIM_COMMITED, successful: true }), 'frombtc'), c.ctx)
  assert.deepEqual(c.said.filter((m) => m.startsWith('Bitcoin transaction')), ['Bitcoin transaction btc-in: 1/3 confirmations', 'Bitcoin transaction btc-in: 0/? confirmations'])
})

test('a swap that expired while waiting for Bitcoin is failed with the reason', async (t) => {
  const { p } = await provider(t)
  const result = await p.run!(quoteFor(swap({ state: FromBTC.CLAIM_COMMITED, afterBtcWait: FromBTC.EXPIRED }), 'frombtc'), context().ctx)
  assert.deepEqual(result, { state: 'failed', detail: 'The swap expired or failed before the Bitcoin was confirmed' })
})

test('a swap that failed while waiting for Bitcoin is failed', async (t) => {
  const { p } = await provider(t)
  const result = await p.run!(quoteFor(swap({ state: FromBTC.CLAIM_COMMITED, afterBtcWait: FromBTC.FAILED }), 'frombtc'), context().ctx)
  assert.equal(result.state, 'failed')
})

test('a settled-but-not-yet-final swap is left pending', async (t) => {
  const { p } = await provider(t)
  const result = await p.run!(quoteFor(swap({ state: FromBTC.CLAIM_CLAIMED }), 'frombtc'), context().ctx)
  assert.deepEqual(result, { state: 'pending', detail: 'Waiting for the swap to settle' })
})

// ---- resuming ----

test('a saved swap without its id cannot be resumed', async (t) => {
  const { p } = await provider(t)
  await assert.rejects(p.resume!(context({ dir: 'tobtc' }).ctx), /^Error: The saved Atomiq swap has no id; it cannot be resumed$/)
})

test('a saved swap without its direction cannot be resumed', async (t) => {
  const { p } = await provider(t)
  await assert.rejects(p.resume!(context({ swapId: 'swap-1' }).ctx), /cannot be resumed/)
})

test('a saved swap the SDK no longer knows is reported with where it looked, and nothing is done', async (t) => {
  const { p, dir } = await provider(t, { stored: undefined })
  const c = context({ swapId: 'swap-1', dir: 'frombtc' })
  await assert.rejects(p.resume!(c.ctx), new RegExp(`^Error: Atomiq has no swap swap-1 in its database \\(${dir.replace(/[/.]/g, '\\$&')}\\); check it by hand before doing anything else$`))
  assert.equal(c.sent.length, 0)
})

// ---- which pairs Atomiq offers ----

test('on test networks Atomiq swaps testnet4 BTC and devnet SOL', async (t) => {
  const BTCT: Token = { chainKey: 'btct', address: 'bitcoin', symbol: 'BTC', decimals: 8 }
  const SOLD: Token = { chainKey: 'sold', address: '11111111111111111111111111111111', symbol: 'SOL', decimals: 9 }
  const MAIN_SOL: Token = { ...SOLD, chainKey: 'sol' }
  const { p } = await provider(t, { testnet: true })
  assert.deepEqual(await p.getQuotes({ from: BTCT, to: MAIN_SOL, amount: 1n, fromAddress: 'a', toAddress: 'b', slippage: 0 }, 'cheapest'), [])
})
