import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultRpcUrls } from '../src/rpc.ts'

test('reviewed hosts replace the operator endpoints LI.FI lists', () => {
  const urls = defaultRpcUrls({ family: 'evm', id: 8453 }, ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'])
  assert.deepEqual(urls.slice(0, 2), ['https://base-rpc.publicnode.com', 'https://base.api.pocket.network'])
  assert.ok(!urls.includes('https://mainnet.base.org'))
})

test('a chain without a reviewed host keeps its own endpoints, minus those not meant for apps', () => {
  assert.deepEqual(defaultRpcUrls({ family: 'evm', id: 424242 }, ['https://rpc.example.org', 'https://mainnet.optimism.io']), ['https://rpc.example.org'])
})

test('Solana uses PublicNode first and never the old mainnet-beta hostname', () => {
  const urls = defaultRpcUrls({ family: 'solana', id: 1151111081099710 }, ['https://api.mainnet-beta.solana.com'])
  assert.equal(urls[0], 'https://solana-rpc.publicnode.com')
  assert.ok(!urls.includes('https://api.mainnet-beta.solana.com'))
})

test('Solana devnet is left alone', () => {
  assert.deepEqual(defaultRpcUrls({ family: 'solana', id: 1151111081099711 }, ['https://api.devnet.solana.com']), ['https://api.devnet.solana.com'])
})
