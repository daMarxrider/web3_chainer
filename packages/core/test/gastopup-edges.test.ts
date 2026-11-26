import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultSettings, gasTopUpUsd, parseGasTopUp, planGasTopUp, stopOvers, stopOverUsd, type GasTopUpSetting, type Token } from '../src/index.ts'

const base = defaultSettings.gasTopUp // multiplier 2, fixed $2
const fixed = (usd: number): GasTopUpSetting => ({ ...base, mode: 'fixed', fixedUsd: usd })
const multiplier = (n: number): GasTopUpSetting => ({ ...base, mode: 'multiplier', multiplier: n })

// ---- parsing overrides ----

test('a multiplier of 0.5 is the smallest allowed', () => {
  assert.equal(parseGasTopUp('0.5x', base).multiplier, 0.5)
})

test('a multiplier just under 0.5 is refused', () => {
  assert.throws(() => parseGasTopUp('0.49x', base), /^Error: The gas multiplier must be between 0\.5 and 20$/)
})

test('a multiplier of 20 is the largest allowed', () => {
  assert.equal(parseGasTopUp('20x', base).multiplier, 20)
})

test('a multiplier just over 20 is refused', () => {
  assert.throws(() => parseGasTopUp('20.1x', base), /between 0\.5 and 20/)
})

test('a fixed $0.10 is the smallest allowed', () => {
  assert.equal(parseGasTopUp('$0.10', base).fixedUsd, 0.1)
})

test('a fixed $0.09 is refused', () => {
  assert.throws(() => parseGasTopUp('$0.09', base), /^Error: The fixed gas amount must be between \$0\.10 and \$50$/)
})

test('a fixed $50 is the largest allowed', () => {
  assert.equal(parseGasTopUp('$50', base).fixedUsd, 50)
})

test('a fixed $50.01 is refused', () => {
  assert.throws(() => parseGasTopUp('$50.01', base), /between \$0\.10 and \$50/)
})

test('overrides are understood in capitals and with spaces around', () => {
  assert.deepEqual([parseGasTopUp(' OFF ', base).mode, parseGasTopUp(' 3X ', base).multiplier], ['off', 3])
})

test('a number without x or $ is refused with examples', () => {
  assert.throws(() => parseGasTopUp('3', base), /^Error: "3" is not a gas top-up setting; use off, a multiplier like 2x, or a fixed value like \$3$/)
})

test('a negative fixed value is refused', () => {
  assert.throws(() => parseGasTopUp('$-1', base), /is not a gas top-up setting/)
})

test('an override keeps the other parts of the setting', () => {
  assert.deepEqual(parseGasTopUp('$5', multiplier(7)), { mode: 'fixed', multiplier: 7, fixedUsd: 5 })
})

// ---- the value ----

test('a fixed value above the $50 cap, saved in the settings file by hand, is capped', () => {
  assert.equal(gasTopUpUsd(fixed(80), undefined).usd, 50)
})

test('a multiplier whose result is above the cap is capped at $50', () => {
  // $30 estimate x 2 = $60
  assert.equal(gasTopUpUsd(multiplier(2), 30).usd, 50)
})

test('an estimate of exactly zero is treated as unknown in the multiplier mode', () => {
  assert.match(gasTopUpUsd(multiplier(2), 0).why ?? '', /gas price of the destination chain is unknown/)
})

// ---- planning a top-up ----

const USDC: Token = { chainKey: 'arb', address: '0xa', symbol: 'USDC', decimals: 6, priceUsd: 1 }
const USDC_BASE: Token = { chainKey: 'bas', address: '0xb', symbol: 'USDC', decimals: 6, priceUsd: 1 }
const ETH_BASE: Token = { chainKey: 'bas', address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, priceUsd: 3000 }
const input = (over: Partial<Parameters<typeof planGasTopUp>[1]> = {}) => ({ source: USDC, destination: USDC_BASE, destNative: ETH_BASE, destNativeBalance: 0n, mainAmount: 100_000_000n, sourceBalance: 200_000_000n, estimatedGasUsd: 0.5, ...over })

test('the extra amount is rounded up to the next base unit', () => {
  // $1.0000001 at $1 with 6 decimals = 1 000 000.1 base units -> 1 000 001
  assert.equal(planGasTopUp(fixed(1.0000001), input()).topUp?.amount, 1_000_001n)
})

test('an extra amount of exactly half the transfer is still added', () => {
  // $2 = 2 000 000 base units; the transfer is 4 000 000.
  assert.equal(planGasTopUp(fixed(2), input({ mainAmount: 4_000_000n })).topUp?.amount, 2_000_000n)
})

test('an extra amount above half the transfer is left out as too large for it', () => {
  assert.equal(planGasTopUp(fixed(2), input({ mainAmount: 3_999_999n })).why, 'the transfer is too small to add the extra amount')
})

test('a wallet holding exactly the transfer plus the extra pays both', () => {
  assert.equal(planGasTopUp(fixed(2), input({ sourceBalance: 102_000_000n })).topUp?.amount, 2_000_000n)
})

test('a wallet one base unit short of the transfer plus the extra gets no top-up, with the reason', () => {
  assert.equal(planGasTopUp(fixed(2), input({ sourceBalance: 101_999_999n })).why, 'the wallet cannot pay the extra amount on top of the transfer')
})

test('a top-up is never planned in the off mode, and says nothing', () => {
  assert.deepEqual(planGasTopUp({ ...base, mode: 'off' }, input()), {})
})

test('a transfer that delivers the destination’s coin needs no top-up', () => {
  assert.equal(planGasTopUp(fixed(2), input({ destination: ETH_BASE })).why, 'the transfer already delivers the destination coin')
})

test('a recipient with even one unit of the coin needs no top-up', () => {
  assert.equal(planGasTopUp(fixed(2), input({ destNativeBalance: 1n })).why, 'the recipient already has gas on the destination')
})

test('a token without a price cannot be sized for a top-up', () => {
  assert.equal(planGasTopUp(fixed(2), input({ source: { ...USDC, priceUsd: undefined } })).why, 'the price of the token is unknown, so the extra amount cannot be worked out')
})

test('a planned top-up goes into the destination’s coin, paid in the sent token, with its dollar value', () => {
  const t = planGasTopUp(fixed(2), input()).topUp!
  assert.deepEqual([t.from.symbol, t.to.symbol, t.usd], ['USDC', 'ETH', 2])
})

// ---- stop-overs ----

const legTo = (to: Token, costUsd: number, toAddress = '0xme') => ({ request: { from: USDC, to, toAddress }, costUsd })

test('a direct route has no stop-overs', () => {
  assert.deepEqual(stopOvers({ legs: [legTo(USDC_BASE, 0.1)] }), [])
})

test('a stop where the chain’s own coin arrives needs no gas sent ahead', () => {
  assert.deepEqual(stopOvers({ legs: [legTo(ETH_BASE, 0.1), legTo(USDC, 0.2)] }), [])
})

test('a stop where a token arrives needs gas for the next leg, at the address it arrives at', () => {
  assert.deepEqual(stopOvers({ legs: [legTo(USDC_BASE, 0.1, '0xtransit'), legTo(USDC, 0.25)] }), [{ chainKey: 'bas', address: '0xtransit', arriving: USDC_BASE, nextCostUsd: 0.25 }])
})

test('the gas for a stop-over is the multiplier of the next leg’s quoted cost', () => {
  assert.equal(stopOverUsd(multiplier(2), { chainKey: 'bas', address: '0x', arriving: USDC_BASE, nextCostUsd: 0.25 }, 9).usd, 0.5)
})

test('a next leg quoted at no cost falls back to the node’s estimate', () => {
  assert.equal(stopOverUsd(multiplier(2), { chainKey: 'bas', address: '0x', arriving: USDC_BASE, nextCostUsd: 0 }, 0.3).usd, 0.6)
})
