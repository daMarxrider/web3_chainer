import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseSaved, listRoutes, loadRoute, removeRoute, routePath, saveRoute, type Quote, type Route, type SavedTransfer, type Store } from '../src/index.ts'

const memory = (): Store => {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)) }
}
const quote = (tool: string, min: bigint): Quote => ({
  provider: 'lifi', tool, request: { from: { chainKey: 'a', address: 'x', symbol: 'U', decimals: 6 }, to: { chainKey: 'b', address: 'y', symbol: 'U', decimals: 6 }, amount: 100n, fromAddress: '', toAddress: '', slippage: 0 },
  toAmount: min, toAmountMin: min, costUsd: 0, etaSeconds: 1, viaSymbols: [], raw: {}, statusRef: {},
})
const route = (tool: string, min: bigint): Route => ({ legs: [quote(tool, min)] })
const saved = (over: Partial<SavedTransfer> = {}): SavedTransfer => ({ kind: 'transfer', name: 'r', createdAt: '', from: 'USDC@a', to: 'USDC@b', amount: 'all', via: 'lifi/across', fallback: false, ...over })

test('save, load, list, remove; names are unique and checked', async () => {
  const store = memory()
  await saveRoute(store, saved({ name: 'Weekly' }))
  await assert.rejects(saveRoute(store, saved({ name: 'weekly' })), /exists/)
  await assert.rejects(saveRoute(store, saved({ name: 'bad name' })), /not a usable name/)
  assert.equal((await loadRoute(store, 'WEEKLY')).name, 'Weekly')
  assert.equal((await listRoutes(store)).length, 1)
  await removeRoute(store, 'weekly')
  assert.equal((await listRoutes(store)).length, 0)
  await assert.rejects(loadRoute(store, 'weekly'), /No saved route/)
  await saveRoute(store, saved({ name: 'weekly' }))
})

test('the stored path is used when it is still offered', () => {
  const choice = chooseSaved(saved(), [route('stargate', 99n), route('across', 90n)])
  assert.deepEqual([routePath(choice.route), choice.usedFallback], ['lifi/across', false])
})

test('a vanished path stops the run unless the fallback is allowed', () => {
  assert.throws(() => chooseSaved(saved(), [route('stargate', 99n)]), /no longer offered/)
  const choice = chooseSaved(saved({ fallback: true }), [route('stargate', 99n)])
  assert.deepEqual([routePath(choice.route), choice.usedFallback], ['lifi/stargate', true])
})

test('a result below the saved minimum stops the run, fallback or not', () => {
  assert.throws(() => chooseSaved(saved({ minReceive: '95' }), [route('across', 90n)]), /below the minimum/)
  assert.throws(() => chooseSaved(saved({ minReceive: '95', fallback: true }), [route('stargate', 90n)]), /below the minimum/)
  assert.equal(chooseSaved(saved({ minReceive: '90' }), [route('across', 90n)]).usedFallback, false)
})
