import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTokenList, popularTokens, searchTokens, TokenIndex, type Chain, type Store, type Token, type TokenList } from '../src/index.ts'

const eth: Chain = { key: 'eth', id: 1, name: 'Ethereum', family: 'evm', nativeSymbol: 'ETH', rpcUrls: [], testnet: false } as Chain
const sep: Chain = { ...eth, key: 'eths', id: 11155111, name: 'Sepolia', testnet: true }
const ZERO = '0x0000000000000000000000000000000000000000'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const FAKE_USDC = '0x1111111111111111111111111111111111111111'
const tok = (symbol: string, address: string, extra: Partial<Token> = {}): Token => ({ chainKey: 'eth', address, symbol, decimals: 18, ...extra })

// Ten listed tokens make Ethereum "covered"; USDC is one of them, the look-alike is not.
const listed = Array.from({ length: 9 }, (_, i) => ({ chainId: 1, address: `0x${'a'.repeat(39)}${i}`, symbol: `T${i}`, name: `Token ${i}` }))
const list: TokenList = { name: 'test', fetchedAt: new Date().toISOString(), tokens: [...listed, { chainId: 1, address: USDC.toLowerCase(), symbol: 'USDC', name: 'USD Coin' }] }
const index = new TokenIndex(list)
const tokens = [
  tok('ETH', ZERO),
  tok('USDC', FAKE_USDC, { screening: 'unverified' }),
  tok('USDC', USDC, { screening: 'verified', name: 'USD Coin' }),
  tok('USDC.e', '0x3333333333333333333333333333333333333333', { screening: 'verified' }),
  tok('USDT', '0x4444444444444444444444444444444444444444', { screening: 'flagged' }),
]

function memoryStore(): Store {
  const data = new Map<string, string>()
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async (p) => [...data.keys()].filter((k) => k.startsWith(p)) }
}

test('trust: the coin and listed tokens first, screening decides the rest, case does not matter for EVM', () => {
  assert.equal(index.trust(tokens[0]!, eth), 'listed')
  assert.equal(index.trust(tokens[2]!, eth), 'listed')
  assert.equal(index.trust(tokens[1]!, eth), 'unknown')
  assert.equal(index.trust(tokens[3]!, eth), 'screened')
  assert.equal(index.trust(tokens[4]!, eth), 'flagged')
  // On test networks every token that is not flagged counts as listed.
  assert.equal(index.trust(tokens[1]!, sep), 'listed')
  assert.equal(index.trust(tokens[4]!, sep), 'flagged')
})

test('search puts the listed token above a look-alike with the same symbol and drops flagged ones', () => {
  const found = searchTokens(tokens, 'usd', eth, index).map((r) => `${r.token.address}:${r.trust}`)
  assert.deepEqual(found, [`${USDC}:listed`, '0x3333333333333333333333333333333333333333:screened', `${FAKE_USDC}:unknown`])
  assert.equal(searchTokens(tokens, 'usdt', eth, index).length, 0)
  // Among equally good matches the usual majors come before the rest.
  const more = [tok('USD1', '0x5555555555555555555555555555555555555555', { screening: 'verified' }), tok('USDC', USDC)]
  assert.deepEqual(searchTokens(more, 'usd', eth, new TokenIndex({ ...list, tokens: [...list.tokens, { chainId: 1, address: '0x5555555555555555555555555555555555555555', symbol: 'USD1', name: '' }] })).map((r) => r.token.symbol), ['USDC', 'USD1'])
  assert.equal(searchTokens(tokens, 'usd coin', eth, index)[0]?.token.address, USDC)
  assert.equal(searchTokens(tokens, USDC.toLowerCase(), eth, index)[0]?.token.address, USDC)
})

test('popular tokens: coin first, one per symbol, only listed on a covered chain', () => {
  assert.deepEqual(popularTokens(tokens, eth, index).map((r) => r.token.address), [ZERO, USDC])
  // A chain the list does not cover also takes screened tokens.
  const thin = new TokenIndex({ ...list, tokens: [] })
  assert.deepEqual(popularTokens(tokens, eth, thin).map((r) => r.token.symbol), ['ETH', 'USDC'])
  assert.equal(popularTokens(tokens, eth, thin)[1]!.token.address, USDC)
})

test('the list is cached for a day and a stale copy is used when the download fails', async () => {
  const store = memoryStore()
  let calls = 0
  const body = JSON.stringify({ name: 'Uniswap Labs Default', tokens: [{ chainId: 501000101, address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Wrapped SOL', decimals: 9 }, { chainId: 1, symbol: 'BAD' }] })
  const ok = (async () => (calls++, new Response(body))) as typeof fetch
  const t0 = Date.parse('2026-11-26T00:00:00Z')
  const first = await loadTokenList(ok, store, t0)
  assert.equal(first?.tokens.length, 1, 'malformed entries are skipped')
  assert.equal(first?.tokens[0]!.chainId, 1151111081099710, 'Solana is mapped to the id the app uses')
  await loadTokenList(ok, store, t0 + 60_000)
  assert.equal(calls, 1, 'a fresh cache is not downloaded again')
  const down = (async () => { throw new Error('offline') }) as typeof fetch
  assert.equal((await loadTokenList(down, store, t0 + 2 * 86_400_000))?.name, 'Uniswap Labs Default')
  assert.equal(await loadTokenList(down, memoryStore(), t0), undefined)
})
