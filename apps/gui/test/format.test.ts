import assert from 'node:assert/strict'
import { test } from 'node:test'
import { amount, duration, shortAddress, usd } from '../src/dom.ts'

const usdc = { decimals: 6 }
const ether = { decimals: 18 }

// ---- token amounts ----

test('trailing zeros of an amount are dropped', () => {
  // 1_500_000 base units of a 6-decimal token = 1.5
  assert.equal(amount(1_500_000n, usdc), '1.5')
})

test('a whole amount has no decimal point', () => {
  assert.equal(amount(2_000_000n, usdc), '2')
})

test('zero is shown as 0', () => {
  assert.equal(amount(0n, usdc), '0')
})

test('thousands are grouped with commas', () => {
  // 1_234_567_890_000 base units = 1,234,567.89
  assert.equal(amount(1_234_567_890_000n, usdc), '1,234,567.89')
})

test('an amount is cut, never rounded up, at six decimals', () => {
  // 1.9999999 ether shown to six decimals must not become 2: the wallet does not hold 2.
  assert.equal(amount(1_999_999_900_000_000_000n, ether), '1.999999')
})

test('a different number of decimals can be asked for', () => {
  assert.equal(amount(1_234_567n, usdc, 2), '1.23')
})

test('asking for no decimals shows only the whole part', () => {
  assert.equal(amount(1_999_999n, usdc, 0), '1')
})

test('an amount in base units may come as text', () => {
  assert.equal(amount('2500000', usdc), '2.5')
})

test('a token without decimals shows whole units', () => {
  assert.equal(amount(42n, { decimals: 0 }), '42')
})

test('a whole part beyond 2^53 keeps every digit', () => {
  // 123,456,789,012,345,678,901 units of a token without decimals; a JavaScript number would print ...680,000.
  assert.equal(amount(123_456_789_012_345_678_901n, { decimals: 0 }), '123,456,789,012,345,678,901')
})

test('a non-zero amount too small for six decimals is not shown as zero', () => {
  // 1 wei of ether is 0.000000000000000001.
  assert.equal(amount(1n, ether), '<0.000001')
})

test('a non-zero amount below one whole unit shows as less than 1 when no decimals are asked for', () => {
  assert.equal(amount(500_000n, usdc, 0), '<1')
})

test('the smallest amount that six decimals can show is shown as it is', () => {
  assert.equal(amount(1_000_000_000_000n, ether), '0.000001')
})

// ---- dollar values ----

test('an unknown dollar value is a question mark', () => {
  assert.equal(usd(undefined), '?')
})

test('a dollar value has two decimals', () => {
  assert.equal(usd(12.5), '$12.50')
})

test('zero dollars is $0.00', () => {
  assert.equal(usd(0), '$0.00')
})

test('a positive value under a cent is shown as less than a cent', () => {
  assert.equal(usd(0.004), '<$0.01')
})

test('exactly one cent is shown as one cent', () => {
  assert.equal(usd(0.01), '$0.01')
})

// ---- durations ----

test('under 90 seconds is shown in seconds', () => {
  assert.equal(duration(89), '89 s')
})

test('from 90 seconds on, durations are shown in whole minutes', () => {
  // 90 s = 1.5 min, rounded to 2.
  assert.equal(duration(90), '2 min')
})

test('just under an hour and a half is still shown in minutes', () => {
  assert.equal(duration(5399), '90 min')
})

test('from an hour and a half on, durations are shown in hours with one decimal', () => {
  assert.equal(duration(5400), '1.5 h')
})

test('a zero duration is 0 s', () => {
  assert.equal(duration(0), '0 s')
})

// ---- addresses ----

test('an address of 18 characters or fewer is shown in full', () => {
  assert.equal(shortAddress('0x1234567890abcdef'), '0x1234567890abcdef')
})

test('a longer address keeps its first eight and last six characters', () => {
  // first eight: 0x9858Ef, last six: aEda94
  assert.equal(shortAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'), '0x9858Ef…aEda94')
})
