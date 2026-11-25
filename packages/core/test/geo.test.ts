import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultSettings, GEO_RESTRICTIONS, geoAllowed, geoKeys, geoNotices, geoStatement } from '../src/index.ts'

const q = (tool: string, provider = 'lifi') => ({ provider, tool })

test('only restricted LI.FI bridges need a confirmation', () => {
  assert.deepEqual(geoKeys([q('across'), q('gnosis'), q('uniswap')]), ['across'])
  assert.deepEqual(geoKeys([q('across', 'other')]), [])
})

test('keys of one service are merged into a single notice', () => {
  const notices = geoNotices([q('mayan'), q('mayanWH'), q('across')])
  assert.deepEqual(notices.map((n) => [n.name, n.keys]), [['Mayan', ['mayan', 'mayanWH']], ['Across', ['across']]])
})

test('a quote is allowed only when unrestricted or confirmed', () => {
  assert.equal(geoAllowed(q('gnosis'), undefined), true)
  assert.equal(geoAllowed(q('across'), undefined), false)
  assert.equal(geoAllowed(q('across'), ['stargateV2']), false)
  assert.equal(geoAllowed(q('across'), ['across']), true)
})

test('a service limited to one country says so in the statement', () => {
  assert.match(geoStatement(geoNotices([q('gasZipBridge')])), /permitted country/)
  assert.doesNotMatch(geoStatement(geoNotices([q('across')])), /permitted country/)
})

test('every entry names regions and its terms; Paxos Labs Transit is denied by default', () => {
  for (const [key, r] of Object.entries(GEO_RESTRICTIONS)) assert.ok(r.regions.length > 0 && r.terms && r.name, key)
  assert.ok(defaultSettings.lifi.denyBridges.includes('paxos'))
  assert.ok(defaultSettings.lifi.denyBridges.includes('unit'))
  assert.equal(geoKeys([q('garden')]).length, 1)
})

test('direct providers are keyed by provider name and need the same confirmation as the matching LI.FI bridge', () => {
  assert.deepEqual(geoKeys([{ provider: 'cctp', tool: 'cctp-fast' }, { provider: 'atomiq', tool: 'btc-sol' }]), ['cctp', 'atomiq'])
  assert.equal(geoAllowed({ provider: 'cctp', tool: 'cctp-fast' }, undefined), false)
  assert.equal(geoAllowed({ provider: 'cctp', tool: 'cctp-standard' }, ['cctp']), true)
  assert.equal(geoAllowed({ provider: 'thorchain', tool: 'thorchain' }, undefined), true)
})
