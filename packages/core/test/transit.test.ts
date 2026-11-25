import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addAccount, loadKeystore, persistTransit, pipelineFromRoute, TransitPool, transitAllowed, unlock, type Quote, type Route, type Store, type Token } from '../src/index.ts'

const memory = (): Store => {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)) }
}
const SOL_CHAIN = { family: 'solana', key: 'sol' } as const
const KEY = '0x' + '11'.repeat(32)
const USDC: Token = { chainKey: 'eth', address: '0xA', symbol: 'USDC', decimals: 6 }
const SOL: Token = { chainKey: 'sol', address: '11111111111111111111111111111111', symbol: 'SOL', decimals: 9 }
const SPL: Token = { chainKey: 'sol', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 }
const OUT: Token = { chainKey: 'bas', address: '0xB', symbol: 'USDC', decimals: 6 }
const leg = (from: Token, to: Token, fromAddress: string, toAddress: string): Quote => ({
  provider: 'x', tool: 'x', request: { from, to, amount: 10n, fromAddress, toAddress, slippage: 0 }, toAmount: 9n, toAmountMin: 9n, costUsd: 0, etaSeconds: 1, viaSymbols: [], raw: {}, statusRef: {},
})

test('one pool address per chain, made in memory, and not stored until a route uses it', async () => {
  const store = memory()
  await addAccount(store, 'main', KEY, 'password1')
  const pool = new TransitPool((await loadKeystore(store)).accounts)
  const a = pool.addressOn(SOL_CHAIN)
  assert.equal(pool.addressOn(SOL_CHAIN), a)
  assert.equal(pool.isTransit(a), true)
  assert.equal((await loadKeystore(store)).accounts.length, 1)
})

test('a route that passes through the stop-over is stored first, then signed by the transit wallet', async () => {
  const store = memory()
  await addAccount(store, 'main', KEY, 'password1')
  const main = (await loadKeystore(store)).accounts[0]!
  const pool = new TransitPool((await loadKeystore(store)).accounts)
  const stop = pool.addressOn(SOL_CHAIN)
  const route: Route = { legs: [leg(USDC, SOL, main.addresses.evm, stop), leg(SOL, OUT, stop, main.addresses.evm)] }
  assert.equal(transitAllowed(route, pool), true)

  const walletOf = await persistTransit(store, pool, route, async () => 'password1')
  const accounts = (await loadKeystore(store)).accounts
  assert.deepEqual(accounts.map((a) => a.name), ['main', 'transit-sol-1'])
  assert.equal(accounts[1]!.transit!.chainKey, 'sol')
  assert.equal(accounts[1]!.addresses.sol, stop)
  // the stored key really is the one behind the address
  assert.equal((await unlock(store, 'transit-sol-1', 'password1')).evm.address, accounts[1]!.addresses.evm)

  const record = pipelineFromRoute(route, 'main', [], walletOf)
  assert.deepEqual(record.legs.map((l) => l.wallet), [undefined, 'transit-sol-1'])
  // a second route reuses it instead of making another
  assert.equal(new TransitPool(accounts).addressOn(SOL_CHAIN), stop)
})

test('a route not using the fresh wallet stores nothing', async () => {
  const store = memory()
  await addAccount(store, 'main', KEY, 'password1')
  const main = (await loadKeystore(store)).accounts[0]!
  const pool = new TransitPool((await loadKeystore(store)).accounts)
  pool.addressOn(SOL_CHAIN)
  await persistTransit(store, pool, { legs: [leg(USDC, OUT, main.addresses.evm, main.addresses.evm)] }, async () => { throw new Error('no password needed') })
  assert.equal((await loadKeystore(store)).accounts.length, 1)
})

test('only the chain coin may wait on a transit wallet', () => {
  const pool = new TransitPool([])
  const stop = pool.addressOn(SOL_CHAIN)
  const bad: Route = { legs: [leg(USDC, SPL, 'a', stop), leg(SPL, OUT, stop, 'b')] }
  assert.equal(transitAllowed(bad, pool), false)
})
