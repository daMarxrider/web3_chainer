import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { THORCHAIN, thorProvider, type Chain, type QuoteRequest, type Token } from '../src/index.ts'

// ---- fixtures ----

const chains: Chain[] = [
  { family: 'evm', key: 'eth', id: 1, name: 'Ethereum', nativeSymbol: 'ETH', rpcUrls: [], testnet: false, nativePriceUsd: 2000 },
  { family: 'bitcoin', key: 'btc', id: 20000000000001, name: 'Bitcoin', nativeSymbol: 'BTC', rpcUrls: [], testnet: false, nativePriceUsd: 60000 },
]
const ETH: Token = { chainKey: 'eth', address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 }
const BTC: Token = { chainKey: 'btc', address: 'bitcoin', symbol: 'BTC', decimals: 8, priceUsd: 60000 }
const ARB_ETH: Token = { chainKey: 'arb', address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 }
const VAULT = '0x0d15b57a5ba0a31a4774c03ddfacf79b289db9ce'
const DEST = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
/** A swap request; the amount defaults to one whole unit (10^18 base units of ETH). */
const request = (from: Token, to: Token, amount = 10n ** 18n): QuoteRequest => ({ from, to, amount, fromAddress: '0xme', toAddress: DEST, slippage: 0.01 })

type QuoteAnswer = Record<string, unknown> | { error: string }
/** A THORNode whose pools, swap quotes (in turn) and inbound list each test sets. */
function node(opts: { pools?: { asset: string; status: string }[]; quotes?: QuoteAnswer[]; inbound?: Record<string, unknown>[] } = {}) {
  const calls: string[] = []
  let quoteNo = 0
  const fetchFn = (async (url: string) => {
    const u = new URL(url)
    calls.push(u.pathname)
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
    if (u.pathname.endsWith('/pools')) return json(opts.pools ?? [{ asset: 'ETH.ETH', status: 'Available' }, { asset: 'BTC.BTC', status: 'Available' }])
    if (u.pathname.endsWith('/inbound_addresses')) return json(opts.inbound ?? [{ chain: 'ETH', address: VAULT, halted: false, gas_rate: '15', gas_rate_units: 'gwei' }])
    if (u.pathname.endsWith('/quote/swap')) {
      const q = (opts.quotes ?? [swapQuote()])[Math.min(quoteNo++, (opts.quotes?.length ?? 1) - 1)]!
      return 'error' in q ? json({ message: q.error }, 400) : json(q)
    }
    return json({}, 404)
  }) as typeof fetch
  return { fetchFn, calls, swapCalls: () => calls.filter((c) => c.endsWith('/quote/swap')).length }
}
/** A node quote for ETH -> BTC paying 0.01 BTC (1 000 000 sats), with the given changes. */
const swapQuote = (over: Record<string, unknown> = {}) => ({ inbound_address: VAULT, expiry: 4102444800, memo: `=:b:${DEST}`, expected_amount_out: '1000000', recommended_min_amount_in: '1000', recommended_gas_rate: '15', gas_rate_units: 'gwei', total_swap_seconds: 42, fees: { total: '1' }, ...over })
const thor = (n: ReturnType<typeof node>) => thorProvider(n.fetchFn, THORCHAIN, chains)

// ---- which swaps are offered ----

test('a chain the network does not serve gives no quote and asks no quote', async () => {
  const n = node()
  assert.deepEqual([await thor(n).getQuotes(request(ARB_ETH, BTC), 'cheapest'), n.swapCalls()], [[], 0])
})

test('a pool that is not available gives no quote', async () => {
  const n = node({ pools: [{ asset: 'ETH.ETH', status: 'Available' }, { asset: 'BTC.BTC', status: 'Staged' }] })
  assert.deepEqual(await thor(n).getQuotes(request(ETH, BTC), 'cheapest'), [])
})

test('the same asset on both sides gives no quote', async () => {
  const n = node()
  assert.deepEqual([await thor(n).getQuotes(request(ETH, ETH), 'cheapest'), n.swapCalls()], [[], 0])
})

test('a destination too long for a Bitcoin memo gives no quote instead of an error', async () => {
  const n = node({ quotes: [{ error: 'memo too long for this chain' }] })
  assert.deepEqual(await thor(n).getQuotes(request(BTC, ETH), 'cheapest'), [])
})

test('any other refusal by the node is passed on', async () => {
  const n = node({ quotes: [{ error: 'trading is halted' }] })
  await assert.rejects(thor(n).getQuotes(request(ETH, BTC), 'cheapest'), /trading is halted/)
})

test('a payout that would not cover the network’s fee is reported in plain words', async () => {
  const n = node({ quotes: [swapQuote({ expected_amount_out: undefined })] })
  await assert.rejects(thor(n).getQuotes(request(ETH, BTC), 'cheapest'), /^Error: This amount is too small to swap: the payout would not cover the network fee$/)
})

test('an amount exactly at the network minimum is quoted', async () => {
  // 0.00001 BTC in the network's 8 decimals is 1 000, the minimum.
  const n = node({ quotes: [swapQuote({ recommended_min_amount_in: '1000' })] })
  assert.equal((await thor(n).getQuotes(request(BTC, ETH, 1000n), 'cheapest')).length, 1)
})

// ---- price impact ----

test('a price impact of exactly 15 % is still offered', async () => {
  const n = node({ quotes: [swapQuote({ fees: { total: '1', slippage_bps: 1500 } })] })
  assert.equal((await thor(n).getQuotes(request(ETH, BTC), 'cheapest')).length, 1)
})

test('a price impact above 15 % is refused as a thin pool', async () => {
  const n = node({ quotes: [swapQuote({ fees: { total: '1', slippage_bps: 1501 } })] })
  await assert.rejects(thor(n).getQuotes(request(ETH, BTC), 'cheapest'), /^Error: The thorchain pool is too thin for this amount \(15\.0 % price impact\)$/)
})

test('a tenth of the price impact is added to the slippage in the worst case', async () => {
  // 1 % slippage + ceil(500 / 10) = 50 bps -> 150 bps off 1 000 000 = 985 000.
  const n = node({ quotes: [swapQuote({ fees: { total: '1', slippage_bps: 500 } })] })
  const [q] = await thor(n).getQuotes(request(ETH, BTC), 'cheapest')
  assert.equal(q!.toAmountMin, 985_000n)
})

test('the expected loss from price impact is priced in dollars', async () => {
  // 0.01 BTC at $60 000 = $600; 50 bps of it = $3.
  const n = node({ quotes: [swapQuote({ fees: { total: '1', slippage_bps: 500 } })] })
  const [q] = await thor(n).getQuotes(request(ETH, BTC), 'cheapest')
  assert.equal(q!.riskUsd, 3)
})

test('pinning: without a price for the token received, the expected loss counts as $0', async () => {
  const unpriced = { ...BTC, priceUsd: undefined }
  const n = node({ quotes: [swapQuote({ fees: { total: '1', slippage_bps: 500 } })] })
  const [q] = await thor(n).getQuotes(request(ETH, unpriced), 'cheapest')
  assert.equal(q!.riskUsd, 0)
})

// ---- time ----

test('the node’s total swap time is used when it gives one', async () => {
  const [q] = await thor(node()).getQuotes(request(ETH, BTC), 'cheapest')
  assert.equal(q!.etaSeconds, 42)
})

test('without a total, the time is inbound confirmation plus outbound delay plus 6 s', async () => {
  const n = node({ quotes: [swapQuote({ total_swap_seconds: undefined, inbound_confirmation_seconds: 600, outbound_delay_seconds: 120 })] })
  const [q] = await thor(n).getQuotes(request(ETH, BTC), 'cheapest')
  assert.equal(q!.etaSeconds, 726)
})

test('without any timing, the time is 6 s', async () => {
  const n = node({ quotes: [swapQuote({ total_swap_seconds: undefined })] })
  const [q] = await thor(n).getQuotes(request(ETH, BTC), 'cheapest')
  assert.equal(q!.etaSeconds, 6)
})

// ---- the pool list ----

test('the pool list is asked once in five minutes', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-26T12:00:00Z') })
  try {
    const n = node()
    const p = thor(n)
    await p.getQuotes(request(ETH, BTC), 'cheapest')
    mock.timers.tick(4 * 60_000)
    await p.getQuotes(request(ETH, BTC), 'cheapest')
    assert.equal(n.calls.filter((c) => c.endsWith('/pools')).length, 1)
  } finally {
    mock.timers.reset()
  }
})

test('the pool list is asked again after five minutes', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-26T12:00:00Z') })
  try {
    const n = node()
    const p = thor(n)
    await p.getQuotes(request(ETH, BTC), 'cheapest')
    mock.timers.tick(5 * 60_000)
    await p.getQuotes(request(ETH, BTC), 'cheapest')
    assert.equal(n.calls.filter((c) => c.endsWith('/pools')).length, 2)
  } finally {
    mock.timers.reset()
  }
})

// ---- building the deposit ----

const quoteThenBuild = async (n: ReturnType<typeof node>) => {
  const p = thor(n)
  const [q] = await p.getQuotes(request(ETH, BTC), 'cheapest')
  return p.buildActions!(q!)
}

test('a rate that fell below the quoted minimum by sending time stops the deposit', async () => {
  // Quoted 1 000 000 (minimum 990 000 at 1 %); 989 999 when sending.
  const n = node({ quotes: [swapQuote(), swapQuote({ expected_amount_out: '989999' })] })
  await assert.rejects(quoteThenBuild(n), /^Error: The thorchain rate moved below your minimum since the quote; nothing was sent$/)
})

test('a rate exactly at the quoted minimum is still sent', async () => {
  const n = node({ quotes: [swapQuote(), swapQuote({ expected_amount_out: '990000' })] })
  assert.equal((await quoteThenBuild(n)).length, 1)
})

test('a halted source chain stops the deposit', async () => {
  const n = node({ inbound: [{ chain: 'ETH', address: VAULT, halted: true }] })
  await assert.rejects(quoteThenBuild(n), /^Error: thorchain has paused deposits on ETH$/)
})

test('paused trading on the source chain stops the deposit', async () => {
  const n = node({ inbound: [{ chain: 'ETH', address: VAULT, halted: false, chain_trading_paused: true }] })
  await assert.rejects(quoteThenBuild(n), /paused deposits on ETH/)
})

test('globally paused trading stops the deposit', async () => {
  const n = node({ inbound: [{ chain: 'ETH', address: VAULT, halted: false, global_trading_paused: true }] })
  await assert.rejects(quoteThenBuild(n), /paused deposits on ETH/)
})

test('a source chain missing from the vault list stops the deposit', async () => {
  const n = node({ inbound: [{ chain: 'BTC', address: 'bc1qvault', halted: false }] })
  await assert.rejects(quoteThenBuild(n), /paused deposits on ETH/)
})

test('a quote naming a different vault than the vault list is refused', async () => {
  const n = node({ quotes: [swapQuote(), swapQuote({ inbound_address: '0x000000000000000000000000000000000000dead' })] })
  await assert.rejects(quoteThenBuild(n), /^Error: thorchain returned inconsistent deposit addresses; refusing to send$/)
})

test('a memo in an unexpected shape is refused rather than extended', async () => {
  const n = node({ quotes: [swapQuote(), swapQuote({ memo: `=:b:${DEST}:0:extra` })] })
  await assert.rejects(quoteThenBuild(n), /^Error: Unexpected thorchain memo "=:b:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq:0:extra"; refusing to send$/)
})

