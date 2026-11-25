import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planSweep, type Quote, type Route, type Token } from '../src/index.ts'

const tok = (symbol: string, chainKey: string, price: number, decimals = 6, address = symbol): Token => ({ chainKey, address, symbol, decimals, priceUsd: price })
const ETH = tok('ETH', 'arb', 2000, 18, '0x0000000000000000000000000000000000000000')
const USDC = tok('USDC', 'arb', 1)
const DAI = tok('DAI', 'arb', 1, 18)
const SHIT = tok('SHIT', 'arb', 0.001, 18)
const dest = (t: Token): Token => ({ ...t, chainKey: 'bas', address: t.address.startsWith('0x0000') ? t.address : `b-${t.symbol}` })

const route = (from: Token, to: Token, amount: bigint, costUsd: number): Route => {
  const q: Quote = { provider: 'x', tool: 'x', request: { from, to, amount, fromAddress: 'a', toAddress: 'b', slippage: 0 }, toAmount: amount, toAmountMin: amount, toAmountUsd: (Number(amount) / 10 ** from.decimals) * (from.priceUsd ?? 0), costUsd, etaSeconds: 1, viaSymbols: [], raw: {}, statusRef: {} }
  return { legs: [q] }
}
const eth = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n
const dai = (n: number) => BigInt(n) * 10n ** 18n

test('tokens go by value, the chain coin goes last with gas held back for the rest', async () => {
  const plan = await planSweep({
    holdings: [
      { token: ETH, balance: eth(1) },
      { token: DAI, balance: dai(50) },
      { token: USDC, balance: 200_000_000n },
    ],
    target: dest,
    findRoute: async (from, to, amount) => route(from, to, amount, from.symbol === 'ETH' ? 1 : 0.5),
  })
  assert.deepEqual(plan.items.map((i) => i.from.symbol), ['USDC', 'DAI', 'ETH'])
  // two token transfers cost 0.5 each, margin x3 = $3 -> 0.0015 ETH; its own cost $1 x3 = $3 -> 0.0015 ETH
  assert.equal(plan.items[2]!.amount, eth(1) - eth(0.003))
  assert.deepEqual(plan.skipped, [])
})

test('tokens without a match, without a route or not worth their fees are skipped with a reason', async () => {
  const plan = await planSweep({
    holdings: [
      { token: USDC, balance: 100_000_000n },
      { token: DAI, balance: dai(1) },
      { token: SHIT, balance: dai(1) },
      { token: tok('ODD', 'arb', 1), balance: 5_000_000n },
    ],
    target: (t) => (t.symbol === 'ODD' ? undefined : dest(t)),
    findRoute: async (from, to, amount) => (from.symbol === 'SHIT' ? undefined : route(from, to, amount, from.symbol === 'DAI' ? 5 : 0.5)),
  })
  assert.deepEqual(plan.items.map((i) => i.from.symbol), ['USDC'])
  const reasons = Object.fromEntries(plan.skipped.map((s) => [s.token.symbol, s.reason]))
  assert.match(reasons.ODD!, /no matching token/)
  assert.match(reasons.SHIT!, /no route/)
  assert.match(reasons.DAI!, /higher than/)
})

test('a coin balance too small for the gas of the other transfers is skipped', async () => {
  const plan = await planSweep({
    holdings: [
      { token: ETH, balance: eth(0.001) },
      { token: USDC, balance: 100_000_000n },
    ],
    target: dest,
    findRoute: async (from, to, amount) => route(from, to, amount, 5),
  })
  assert.deepEqual(plan.items.map((i) => i.from.symbol), ['USDC'])
  assert.match(plan.skipped[0]!.reason, /too small/)
})

test('a token that is also the chain gas coin goes last with gas held back', async () => {
  const ARC_USDC = tok('USDC', 'arc', 1)
  const plan = await planSweep({
    holdings: [{ token: ARC_USDC, balance: 20_000_000n }],
    target: (t) => ({ ...t, chainKey: 'bas', address: 'b-USDC' }),
    isGasCoin: (t) => t.symbol === 'USDC',
    findRoute: async (from, to, amount) => route(from, to, amount, 0.5),
  })
  // own transfer cost $0.5 x 3 held back
  assert.equal(plan.items[0]!.amount, 20_000_000n - 1_500_000n)
})

test('empty balances are ignored', async () => {
  const plan = await planSweep({ holdings: [{ token: USDC, balance: 0n }], target: dest, findRoute: async () => undefined })
  assert.deepEqual(plan, { items: [], skipped: [] })
})
