import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultSettings, isAvoided, isSymbolAvoided, loadSettings, saveSettings, type Settings, type Store } from '../src/index.ts'

/** A store holding one settings file with the given text, or none. */
function storeWith(settingsJson?: string): Store {
  const data = new Map<string, string>(settingsJson === undefined ? [] : [['settings.json', settingsJson]])
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async (p) => [...data.keys()].filter((k) => k.startsWith(p)) }
}

// ---- loading ----

test('with no settings saved, the defaults apply: cheapest first, 0.5 % slippage, no limit, 3 hops', async () => {
  const s = await loadSettings(storeWith())
  assert.deepEqual([s.prefer, s.slippage, s.maxUsdPerTransfer, s.maxHops], ['cheapest', 0.005, null, 3])
})

test('with no settings saved, Paxos and Unit are denied and every other bridge allowed', async () => {
  assert.deepEqual((await loadSettings(storeWith())).lifi, { allowBridges: [], denyBridges: ['paxos', 'unit'] })
})

test('with no settings saved, BlockCypher stays off until the user allows it', async () => {
  assert.equal((await loadSettings(storeWith())).blockcypher, false)
})

test('with no settings saved, the gas top-up is twice the estimated gas cost', async () => {
  assert.deepEqual((await loadSettings(storeWith())).gasTopUp, { mode: 'multiplier', multiplier: 2, fixedUsd: 2 })
})

test('a saved value replaces its default and leaves the others alone', async () => {
  const s = await loadSettings(storeWith('{"slippage":0.01}'))
  assert.deepEqual([s.slippage, s.prefer, s.maxHops], [0.01, 'cheapest', 3])
})

test('a saved allow list keeps the default deny list', async () => {
  const s = await loadSettings(storeWith('{"lifi":{"allowBridges":["across"]}}'))
  assert.deepEqual(s.lifi, { allowBridges: ['across'], denyBridges: ['paxos', 'unit'] })
})

test('a saved deny list replaces the default one, so a user can allow Paxos again', async () => {
  const s = await loadSettings(storeWith('{"lifi":{"denyBridges":[]}}'))
  assert.deepEqual(s.lifi.denyBridges, [])
})

test('a saved top-up mode keeps the default multiplier and fixed amount', async () => {
  const s = await loadSettings(storeWith('{"gasTopUp":{"mode":"off"}}'))
  assert.deepEqual(s.gasTopUp, { mode: 'off', multiplier: 2, fixedUsd: 2 })
})

test('an old single top-up amount in USD becomes the fixed mode with that amount', async () => {
  const s = await loadSettings(storeWith('{"gasTopUpUsd":5}'))
  assert.deepEqual(s.gasTopUp, { mode: 'fixed', multiplier: 2, fixedUsd: 5 })
})

test('an old top-up amount of zero becomes the off mode, keeping the default fixed amount', async () => {
  const s = await loadSettings(storeWith('{"gasTopUpUsd":0}'))
  assert.deepEqual(s.gasTopUp, { mode: 'off', multiplier: 2, fixedUsd: 2 })
})

test('an old top-up amount is ignored when the new setting is also saved', async () => {
  const s = await loadSettings(storeWith('{"gasTopUpUsd":5,"gasTopUp":{"mode":"multiplier","multiplier":3}}'))
  assert.deepEqual(s.gasTopUp, { mode: 'multiplier', multiplier: 3, fixedUsd: 2 })
})

test('a damaged settings file is reported by name, not as a bare parse error', async () => {
  await assert.rejects(loadSettings(storeWith('{"slippage":0.01,')), /^Error: The settings file \(settings\.json\) is damaged and could not be read: /)
})

test('loading never changes the shared defaults', async () => {
  const s = await loadSettings(storeWith())
  s.lifi.denyBridges.push('across')
  s.gasTopUp.multiplier = 9
  assert.deepEqual([defaultSettings.lifi.denyBridges, defaultSettings.gasTopUp.multiplier], [['paxos', 'unit'], 2])
})

// ---- saving ----

test('saved settings load back the same', async () => {
  const store = storeWith()
  const mine: Settings = { ...defaultSettings, slippage: 0.02, maxUsdPerTransfer: 500, avoidTokens: ['USDT'], rpc: { eth: 'https://my.node' }, disabledProviders: ['maya'], blockcypher: true, gasTopUp: { mode: 'fixed', multiplier: 2, fixedUsd: 4 } }
  await saveSettings(store, mine)
  assert.deepEqual(await loadSettings(store), mine)
})

// ---- the avoid list ----

const usdtOnEth = { symbol: 'USDT', chainKey: 'eth', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }
const avoiding = (...avoidTokens: string[]): Settings => ({ ...defaultSettings, avoidTokens })

test('a token is avoided by its symbol in any letter case', () => {
  assert.equal(isAvoided(avoiding('usdt'), usdtOnEth), true)
})

test('a token is avoided by chain and address in any letter case', () => {
  assert.equal(isAvoided(avoiding('ETH:0xdac17f958d2ee523a2206206994597c13d831ec7'), usdtOnEth), true)
})

test('an address entry for another chain does not avoid the token here', () => {
  assert.equal(isAvoided(avoiding('arb:0xdAC17F958D2ee523a2206206994597C13D831ec7'), usdtOnEth), false)
})

test('a symbol entry does not match a token whose symbol only contains it', () => {
  assert.equal(isAvoided(avoiding('USD'), usdtOnEth), false)
})

test('an empty avoid list avoids nothing', () => {
  assert.equal(isAvoided(avoiding(), usdtOnEth), false)
})

test('a symbol is avoided when listed, in any letter case', () => {
  assert.equal(isSymbolAvoided(avoiding('Usdt'), 'USDT'), true)
})

test('a symbol is not avoided because of an address entry', () => {
  assert.equal(isSymbolAvoided(avoiding('eth:0xdAC17F958D2ee523a2206206994597C13D831ec7'), 'USDT'), false)
})
