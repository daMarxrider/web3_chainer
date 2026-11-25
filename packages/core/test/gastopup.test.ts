import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateGasUsd, gasTopUpUsd, parseGasTopUp, planGasTopUp, defaultSettings, loadSettings, type Chain, type GasTopUpSetting, type Store, type Token } from '../src/index.ts'

const USDC: Token = { chainKey: 'arb', address: '0xA', symbol: 'USDC', decimals: 6, priceUsd: 1 }
const OUT: Token = { chainKey: 'bas', address: '0xB', symbol: 'USDC', decimals: 6, priceUsd: 1 }
const ETH: Token = { chainKey: 'bas', address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, priceUsd: 2000 }
const base = { source: USDC, destination: OUT, destNative: ETH, destNativeBalance: 0n, mainAmount: 100_000_000n, sourceBalance: 200_000_000n, estimatedGasUsd: 0.5 }
const mult = (multiplier: number): GasTopUpSetting => ({ mode: 'multiplier', multiplier, fixedUsd: 2 })
const fixed = (fixedUsd: number): GasTopUpSetting => ({ mode: 'fixed', multiplier: 2, fixedUsd })

test('the default is twice the estimated gas cost', () => {
  assert.deepEqual(defaultSettings.gasTopUp, { mode: 'multiplier', multiplier: 2, fixedUsd: 2 })
  assert.deepEqual(planGasTopUp(defaultSettings.gasTopUp, base).topUp, { from: USDC, to: ETH, amount: 1_000_000n, usd: 1 })
})
test('the multiplier is adjustable and the fixed mode ignores the estimate', () => {
  assert.equal(planGasTopUp(mult(3), base).topUp!.usd, 1.5)
  assert.equal(planGasTopUp(fixed(4), { ...base, estimatedGasUsd: undefined }).topUp!.amount, 4_000_000n)
})
test('without a gas estimate the multiplier mode says what to do', () => {
  assert.match(planGasTopUp(mult(2), { ...base, estimatedGasUsd: undefined }).why!, /fixed value/)
})
test('off does nothing; the sanity cap holds', () => {
  assert.deepEqual(planGasTopUp({ ...fixed(1), mode: 'off' }, base), {})
  assert.equal(gasTopUpUsd(mult(20), 100).usd, 50)
})
test('not needed or not possible: reasons given', () => {
  const s = mult(2)
  assert.match(planGasTopUp(s, { ...base, destNativeBalance: 1n }).why!, /already has gas/)
  assert.match(planGasTopUp(s, { ...base, destination: ETH }).why!, /already delivers/)
  assert.match(planGasTopUp(s, { ...base, mainAmount: 1_500_000n }).why!, /too small/)
  assert.match(planGasTopUp(s, { ...base, sourceBalance: 100_500_000n }).why!, /cannot pay/)
  assert.match(planGasTopUp(s, { ...base, source: { ...USDC, priceUsd: undefined } }).why!, /price/)
})
test('command-line and plan overrides', () => {
  const b = defaultSettings.gasTopUp
  assert.deepEqual(parseGasTopUp('3x', b), { mode: 'multiplier', multiplier: 3, fixedUsd: 2 })
  assert.deepEqual(parseGasTopUp('$5', b), { mode: 'fixed', multiplier: 2, fixedUsd: 5 })
  assert.equal(parseGasTopUp('off', b).mode, 'off')
  assert.throws(() => parseGasTopUp('25x', b), /between/)
  assert.throws(() => parseGasTopUp('lots', b), /not a gas top-up/)
})
test('settings saved with the old single value keep working', async () => {
  const store: Store = { get: async () => JSON.stringify({ gasTopUpUsd: 3 }), set: async () => {}, keys: async () => [] }
  assert.deepEqual((await loadSettings(store)).gasTopUp, { mode: 'fixed', multiplier: 2, fixedUsd: 3 })
})
test('the estimate is the node gas price times the onward gas units times the coin price', async () => {
  const chain: Chain = { family: 'evm', key: 'bas', id: 8453, name: 'Base', nativeSymbol: 'ETH', nativePriceUsd: 2000, rpcUrls: ['http://rpc.test'], testnet: false }
  const fetchFn: typeof fetch = async (_url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init!.body)).id, result: '0x3b9aca00' }), { status: 200 })
  // 1 gwei x 150 000 gas = 0.00015 ETH = $0.30
  const usd = await estimateGasUsd(chain, fetchFn)
  assert.ok(Math.abs(usd! - 0.3) < 1e-9)
  assert.equal(await estimateGasUsd({ ...chain, nativePriceUsd: undefined }, fetchFn), undefined)
})

import { stopOverUsd, stopOvers, transitAllowed, TransitPool } from '../src/index.ts'

const leg = (from: Token, to: Token, toAddress: string, costUsd: number) => ({ request: { from, to, toAddress }, costUsd })
const SOLNAT: Token = { chainKey: 'sol', address: '11111111111111111111111111111111', symbol: 'SOL', decimals: 9, priceUsd: 100 }
const SPL: Token = { chainKey: 'sol', address: 'EPjF', symbol: 'USDC', decimals: 6, priceUsd: 1 }

test('stop-overs are the chains between legs where something other than the coin waits', () => {
  const route = { legs: [leg(USDC, SPL, 'solAddr', 1), leg(SPL, OUT, 'me', 0.04)] }
  assert.deepEqual(stopOvers(route), [{ chainKey: 'sol', address: 'solAddr', arriving: SPL, nextCostUsd: 0.04 }])
  assert.deepEqual(stopOvers({ legs: [leg(USDC, SOLNAT, 'solAddr', 1), leg(SOLNAT, OUT, 'me', 0.04)] }), [])
  assert.deepEqual(stopOvers({ legs: [leg(USDC, OUT, 'me', 1)] }), [])
})
test('the stop-over gas is the multiplier of the next leg cost, or the estimate when the quote has none, or the fixed value', () => {
  const stop = { chainKey: 'sol', address: 'a', arriving: SPL, nextCostUsd: 0.04 }
  assert.equal(stopOverUsd(mult(2), stop, 9).usd, 0.08)
  assert.equal(stopOverUsd(mult(2), { ...stop, nextCostUsd: 0 }, 0.25).usd, 0.5)
  assert.equal(stopOverUsd(fixed(1), stop, undefined).usd, 1)
  assert.match(stopOverUsd(mult(2), { ...stop, nextCostUsd: 0 }, undefined).why!, /unknown/)
})
test('a transit wallet may hold another token only when gas is sent ahead', () => {
  const pool = new TransitPool([])
  const stop = pool.addressOn({ family: 'solana', key: 'sol' })
  const route = { legs: [{ request: { from: USDC, to: SPL, fromAddress: 'a', toAddress: stop, amount: 1n, slippage: 0 }, costUsd: 0 }, { request: { from: SPL, to: OUT, fromAddress: stop, toAddress: 'b', amount: 1n, slippage: 0 }, costUsd: 0 }] } as never
  assert.equal(transitAllowed(route, pool), false)
  assert.equal(transitAllowed(route, pool, true), true)
})
