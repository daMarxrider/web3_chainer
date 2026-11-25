import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planGasTopUp, type Token } from '../src/index.ts'

const USDC: Token = { chainKey: 'arb', address: '0xA', symbol: 'USDC', decimals: 6, priceUsd: 1 }
const OUT: Token = { chainKey: 'bas', address: '0xB', symbol: 'USDC', decimals: 6, priceUsd: 1 }
const ETH: Token = { chainKey: 'bas', address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, priceUsd: 2000 }
const base = { source: USDC, destination: OUT, destNative: ETH, destNativeBalance: 0n, mainAmount: 100_000_000n, sourceBalance: 200_000_000n }

test('off by default', () => {
  assert.deepEqual(planGasTopUp({ gasTopUpUsd: 0 }, base), {})
})
test('a recipient with no gas gets the configured value, in the source token', () => {
  assert.deepEqual(planGasTopUp({ gasTopUpUsd: 2 }, base).topUp, { from: USDC, to: ETH, amount: 2_000_000n, usd: 2 })
})
test('the cap applies whatever is configured', () => {
  assert.equal(planGasTopUp({ gasTopUpUsd: 500 }, base).topUp!.amount, 10_000_000n)
})
test('not needed or not possible: reasons given', () => {
  const s = { gasTopUpUsd: 2 }
  assert.match(planGasTopUp(s, { ...base, destNativeBalance: 1n }).why!, /already has gas/)
  assert.match(planGasTopUp(s, { ...base, destination: ETH }).why!, /already delivers/)
  assert.match(planGasTopUp(s, { ...base, mainAmount: 3_000_000n }).why!, /too small/)
  assert.match(planGasTopUp(s, { ...base, sourceBalance: 101_000_000n }).why!, /cannot pay/)
  assert.match(planGasTopUp(s, { ...base, source: { ...USDC, priceUsd: undefined } }).why!, /price/)
})
