import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTokenList, popularTokens, searchTokens, TokenIndex, type Chain, type ListedToken, type Store, type Token } from '../src/index.ts'

// ---- chains ----

const ethereum = { key: 'eth', id: 1, name: 'Ethereum', family: 'evm', nativeSymbol: 'ETH', rpcUrls: [], testnet: false } as Chain
const sepolia = { ...ethereum, key: 'eths', id: 11155111, name: 'Sepolia', testnet: true } as Chain

// ---- tokens, named for their role ----

const token = (symbol: string, address: string, extra: Partial<Token> = {}): Token => ({ chainKey: 'eth', address, symbol, decimals: 18, ...extra })
const ether = token('ETH', '0x0000000000000000000000000000000000000000')
/** Circle's USDC: on the curated list (which spells the address in lower case) and passed LI.FI's screening. */
const realUsdc = token('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', { screening: 'verified', name: 'USD Coin' })
/** A copy with the same symbol: not on the list, never screened. */
const lookAlikeUsdc = token('USDC', '0x1111111111111111111111111111111111111111', { screening: 'unverified' })
/** A real bridged token that is simply not on the list: passed screening. */
const bridgedUsdc = token('USDC.e', '0x3333333333333333333333333333333333333333', { screening: 'verified' })
/** LI.FI's screening flagged it. */
const scamUsdt = token('USDT', '0x4444444444444444444444444444444444444444', { screening: 'flagged' })
/** On the list, but not one of the usual majors. */
const obscureStable = token('USD1', '0x5555555555555555555555555555555555555555', { screening: 'verified' })

/**
 * A curated list for Ethereum with the given tokens, padded to ten entries: from ten on, a chain counts as
 * covered by the list and only listed tokens are offered as popular.
 */
function coveredList(...onList: Token[]): ListedToken[] {
  const entries = onList.map((t) => ({ chainId: 1, address: t.address.toLowerCase(), symbol: t.symbol, name: t.name ?? t.symbol }))
  const padding = Array.from({ length: 10 - entries.length }, (_, i) => ({ chainId: 1, address: `0x${'a'.repeat(39)}${i}`, symbol: `PAD${i}`, name: `Padding ${i}` }))
  return [...entries, ...padding]
}
const curated = new TokenIndex({ name: 'test list', fetchedAt: '2026-11-26T00:00:00.000Z', tokens: coveredList(realUsdc, obscureStable) })
const noList = new TokenIndex(undefined)

// ---- trust ----

test('a chain’s own coin counts as listed although the list never contains it', () => {
  assert.equal(curated.trust(ether, ethereum), 'listed')
})

test('a token on the list counts as listed although the list spells its address in lower case', () => {
  assert.equal(curated.trust(realUsdc, ethereum), 'listed')
})

test('a token off the list that passed LI.FI’s screening counts as screened', () => {
  assert.equal(curated.trust(bridgedUsdc, ethereum), 'screened')
})

test('a token neither on the list nor screened counts as unknown', () => {
  assert.equal(curated.trust(lookAlikeUsdc, ethereum), 'unknown')
})

test('a token flagged by the screening counts as flagged', () => {
  assert.equal(curated.trust(scamUsdt, ethereum), 'flagged')
})

test('on a test network an unchecked token counts as listed, since test tokens have no value', () => {
  assert.equal(curated.trust(lookAlikeUsdc, sepolia), 'listed')
})

test('on a test network a flagged token still counts as flagged', () => {
  assert.equal(curated.trust(scamUsdt, sepolia), 'flagged')
})

// ---- search ----

test('search puts the listed token above a look-alike with the same symbol', () => {
  const found = searchTokens([lookAlikeUsdc, realUsdc], 'usdc', ethereum, curated)
  assert.deepEqual(found.map((r) => r.token.address), [realUsdc.address, lookAlikeUsdc.address])
})

test('search puts a listed partial match above an unchecked exact match, so a look-alike cannot jump the queue', () => {
  // "USDC.e" only starts with "usdc" but is listed; the look-alike is called exactly "USDC" but is unknown.
  const listsBridged = new TokenIndex({ name: 'test list', fetchedAt: '2026-11-26T00:00:00.000Z', tokens: coveredList(bridgedUsdc) })
  const found = searchTokens([lookAlikeUsdc, bridgedUsdc], 'usdc', ethereum, listsBridged)
  assert.deepEqual(found.map((r) => r.token.address), [bridgedUsdc.address, lookAlikeUsdc.address])
})

test('search never returns flagged tokens', () => {
  assert.deepEqual(searchTokens([scamUsdt], 'usdt', ethereum, curated), [])
})

test('among equally good listed matches, search puts the usual majors first', () => {
  // Both are listed and both start with "usd"; USDC is a major, USD1 is not, although "USD1" sorts first by name.
  const found = searchTokens([obscureStable, realUsdc], 'usd', ethereum, curated)
  assert.deepEqual(found.map((r) => r.token.symbol), ['USDC', 'USD1'])
})

test('search finds a token by its name', () => {
  assert.deepEqual(searchTokens([realUsdc, bridgedUsdc], 'usd coin', ethereum, curated).map((r) => r.token.address), [realUsdc.address])
})

test('search finds a token by its contract address in any case', () => {
  assert.deepEqual(searchTokens([realUsdc, lookAlikeUsdc], '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ethereum, curated).map((r) => r.token.symbol), ['USDC'])
})

test('search with an empty query returns nothing', () => {
  assert.deepEqual(searchTokens([realUsdc], '  ', ethereum, curated), [])
})

// ---- popular tokens ----

test('popular tokens on a covered chain are the coin first, then listed majors only', () => {
  // bridgedUsdc (screened) and lookAlikeUsdc (unknown) are left out; USD1 is listed but not a major.
  const popular = popularTokens([lookAlikeUsdc, bridgedUsdc, obscureStable, realUsdc, ether], ethereum, curated)
  assert.deepEqual(popular.map((r) => r.token.address), [ether.address, realUsdc.address])
})

test('popular tokens on a chain without a list also take screened tokens, but not unknown ones', () => {
  const popular = popularTokens([lookAlikeUsdc, realUsdc, ether], ethereum, noList)
  assert.deepEqual(popular.map((r) => r.token.address), [ether.address, realUsdc.address])
})

// ---- loading the list ----

function memoryStore(): Store {
  const data = new Map<string, string>()
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async (p) => [...data.keys()].filter((k) => k.startsWith(p)) }
}
/** A token list download that answers with one valid Solana entry and one entry missing its address. */
function listServer() {
  let downloads = 0
  const body = JSON.stringify({
    name: 'Uniswap Labs Default',
    tokens: [
      { chainId: 501000101, address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Wrapped SOL', decimals: 9 },
      { chainId: 1, symbol: 'NO-ADDRESS' },
    ],
  })
  const fetchFn = (async () => (downloads++, new Response(body))) as typeof fetch
  return { fetchFn, downloads: () => downloads }
}
const offline = (async () => {
  throw new Error('offline')
}) as typeof fetch
const NOV_26 = Date.parse('2026-11-26T00:00:00Z')
const HOUR = 3_600_000

test('a downloaded list keeps valid entries and skips malformed ones', async () => {
  const { list } = await loadTokenList(listServer().fetchFn, memoryStore(), NOV_26)
  assert.deepEqual(list?.tokens.map((t) => t.symbol), ['SOL'])
})

test('the list’s Solana chain id is mapped to the one the app uses', async () => {
  const { list } = await loadTokenList(listServer().fetchFn, memoryStore(), NOV_26)
  assert.equal(list?.tokens[0]!.chainId, 1151111081099710)
})

test('a list less than a day old is taken from the cache without downloading', async () => {
  const server = listServer()
  const store = memoryStore()
  await loadTokenList(server.fetchFn, store, NOV_26)
  await loadTokenList(server.fetchFn, store, NOV_26 + 23 * HOUR)
  assert.equal(server.downloads(), 1)
})

test('a list a day old or more is downloaded again', async () => {
  const server = listServer()
  const store = memoryStore()
  await loadTokenList(server.fetchFn, store, NOV_26)
  await loadTokenList(server.fetchFn, store, NOV_26 + 25 * HOUR)
  assert.equal(server.downloads(), 2)
})

test('a failed download falls back to the stale copy and says which day it is from', async () => {
  const store = memoryStore()
  await loadTokenList(listServer().fetchFn, store, NOV_26)
  const load = await loadTokenList(offline, store, NOV_26 + 48 * HOUR)
  assert.deepEqual([load.list?.name, load.problem], ['Uniswap Labs Default', 'The token list could not be updated (offline); using the copy from 2026-11-26'])
})

test('a failed download with nothing cached returns no list and says screening alone decides', async () => {
  const load = await loadTokenList(offline, memoryStore(), NOV_26)
  assert.deepEqual([load.list, load.problem], [undefined, "The token list could not be loaded (offline); tokens are judged by LI.FI's screening only"])
})

// ---- remaining branches ----

const solana = { family: 'solana', key: 'sol', id: 1151111081099710, name: 'Solana', nativeSymbol: 'SOL', rpcUrls: [], testnet: false } as Chain
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const solToken = (address: string, symbol: string): Token => ({ chainKey: 'sol', address, symbol, decimals: 6, screening: 'verified' })
const solList = new TokenIndex({ name: 't', fetchedAt: '2026-11-26T00:00:00.000Z', tokens: [{ chainId: 1151111081099710, address: JUP, symbol: 'JUP', name: 'Jupiter' }] })

test('a Solana address on the list matches only in its exact letter case', () => {
  assert.deepEqual([solList.trust(solToken(JUP, 'JUP'), solana), solList.trust(solToken(JUP.toLowerCase(), 'JUP'), solana)], ['listed', 'screened'])
})

test('a token list without a token array is reported, and screening alone decides', async () => {
  const notAList = (async () => new Response('{"name":"x"}')) as typeof fetch
  assert.equal((await loadTokenList(notAList, memoryStore(), NOV_26)).problem, "The token list could not be loaded (The token list has no tokens); tokens are judged by LI.FI's screening only")
})

test('a token list with only broken entries is reported as having no usable tokens', async () => {
  const broken = (async () => new Response('{"tokens":[{"symbol":"X"}]}')) as typeof fetch
  assert.match((await loadTokenList(broken, memoryStore(), NOV_26)).problem ?? '', /The token list has no usable tokens/)
})

test('a list entry without a name is named by its symbol', async () => {
  const nameless = (async () => new Response('{"name":"x","tokens":[{"chainId":1,"address":"0xa","symbol":"AAA"}]}')) as typeof fetch
  assert.equal((await loadTokenList(nameless, memoryStore(), NOV_26)).list?.tokens[0]!.name, 'AAA')
})

test('a list without a name of its own is called the Uniswap default token list', async () => {
  const unnamed = (async () => new Response('{"tokens":[{"chainId":1,"address":"0xa","symbol":"AAA","name":"A"}]}')) as typeof fetch
  assert.equal((await loadTokenList(unnamed, memoryStore(), NOV_26)).list?.name, 'Uniswap default token list')
})

test('a list entry’s chain id other than Solana’s is kept as it is', async () => {
  const base = (async () => new Response('{"tokens":[{"chainId":8453,"address":"0xa","symbol":"AAA","name":"A"}]}')) as typeof fetch
  assert.equal((await loadTokenList(base, memoryStore(), NOV_26)).list?.tokens[0]!.chainId, 8453)
})

test('search finds a token by the name the list gives it', () => {
  const named = new TokenIndex({ name: 't', fetchedAt: '2026-11-26T00:00:00.000Z', tokens: coveredList({ ...bridgedUsdc, name: 'Bridged USD Coin' }) })
  assert.deepEqual(searchTokens([bridgedUsdc], 'bridged', ethereum, named).map((r) => r.token.address), [bridgedUsdc.address])
})

test('search does not match a token without any name on its name', () => {
  assert.deepEqual(searchTokens([{ ...lookAlikeUsdc, name: undefined }], 'coin', ethereum, curated), [])
})

test('search finds a token whose symbol contains the query in the middle', () => {
  assert.deepEqual(searchTokens([bridgedUsdc], 'dc.', ethereum, curated).map((r) => r.token.symbol), ['USDC.e'])
})

test('among equal matches the chain’s coin comes first, then majors, then the rest by symbol', () => {
  const zed = token('ZED', '0x6666666666666666666666666666666666666666', { screening: 'verified' })
  const abc = token('ABC', '0x7777777777777777777777777777777777777777', { screening: 'verified' })
  // Every token named "<symbol> token", so one name query matches them all equally.
  const named = (t: Token): Token => ({ ...t, name: `${t.symbol} token` })
  const all = new TokenIndex({ name: 't', fetchedAt: '2026-11-26T00:00:00.000Z', tokens: coveredList(named(zed), named(abc), named(realUsdc)) })
  const found = searchTokens([named(zed), named(abc), named(realUsdc), named(ether)], 'token', ethereum, all)
  assert.deepEqual(found.map((r) => r.token.symbol), ['ETH', 'USDC', 'ABC', 'ZED'])
})
