// The remaining branches of the smaller core modules, one claim per test.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mnemonicToSeedSync } from '@scure/bip39'
import { mnemonicToAccount } from 'viem/accounts'
import {
  addAddress,
  addAccount,
  addressSlot,
  bitcoinAdapter,
  BUILTIN_CHAINS,
  builtinNativeToken,
  chainAddress,
  chooseSaved,
  defaultSettings,
  estimateGasUsd,
  findChain,
  gasTopUpUsd,
  legacyUtxoAdapter,
  loadKeystore,
  loadRoute,
  loadSdk,
  persistTransit,
  rankQuotes,
  removeAddress,
  removeRoute,
  sdkStatus,
  TransitPool,
  UTXO_COINS,
  utxoKey,
  type Chain,
  type Quote,
  type Route,
  type Store,
} from '../src/index.ts'
import { FileUnifiedStorage } from '../src/providers/atomiq-storage.ts'
import { defaultRpcUrls } from '../src/rpc.ts'

function memoryStore(): Store {
  const data = new Map<string, string>()
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async (p) => [...data.keys()].filter((k) => k.startsWith(p)) }
}
/** A keystore that derives with 1 000 PBKDF2 rounds, so wallet tests run fast. */
function fastStore(): Store {
  const s = memoryStore()
  void s.set('keystore.json', JSON.stringify({ version: 1, salt: '0x00112233445566778899aabbccddeeff', iterations: 1000, accounts: [] }))
  return s
}
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// ---- address book ----

const valid = () => true

test('an address book label of only spaces is refused as empty', () => {
  assert.throws(() => addAddress(defaultSettings, { label: '   ', chainKey: 'eth', address: '0x1' }, valid), /^Error: The label must not be empty$/)
})

test('removing a label that exists only on another chain names the chain asked for', () => {
  const s = addAddress(defaultSettings, { label: 'cold', chainKey: 'eth', address: '0x1' }, valid)
  assert.throws(() => removeAddress(s, 'cold', 'arb'), /^Error: No address book entry "cold" on arb$/)
})

test('removing a label without a chain removes it on every chain', () => {
  const s = addAddress(addAddress(defaultSettings, { label: 'cold', chainKey: 'eth', address: '0x1' }, valid), { label: 'cold', chainKey: 'arb', address: '0x2' }, valid)
  assert.deepEqual(removeAddress(s, 'COLD').addressBook, [])
})

test('removing a label that does not exist at all says so without a chain', () => {
  assert.throws(() => removeAddress(defaultSettings, 'nope'), /^Error: No address book entry "nope"$/)
})

// ---- endpoints for Bitcoin-family chains ----

test('an RPC override replaces a Bitcoin chain’s own endpoints', async () => {
  const asked: string[] = []
  const fetchFn = (async (url: string) => (asked.push(new URL(url).host), new Response(JSON.stringify({ chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } })))) as typeof fetch
  await bitcoinAdapter(BUILTIN_CHAINS.find((c) => c.key === 'btct')!, { fetch: fetchFn, rpcUrl: 'https://my.esplora/api' }).getBalances('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', [])
  assert.deepEqual(asked, ['my.esplora'])
})

test('an RPC override replaces a legacy coin’s endpoint and needs no BlockCypher permission', async () => {
  const asked: string[] = []
  const fetchFn = (async (url: string) => (asked.push(new URL(url).host), new Response(JSON.stringify({ final_balance: 3 })))) as typeof fetch
  const doge = BUILTIN_CHAINS.find((c) => c.key === 'doge')!
  await legacyUtxoAdapter(doge, UTXO_COINS.doge!, { fetch: fetchFn, rpcUrl: 'https://my.doge/api' }).getBalances('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', [])
  assert.deepEqual(asked, ['my.doge'])
})

test('a legacy chain without endpoints of its own uses the coin’s default', async () => {
  const asked: string[] = []
  const fetchFn = (async (url: string) => (asked.push(new URL(url).host), new Response(JSON.stringify({ final_balance: 3 })))) as typeof fetch
  const doge = { ...BUILTIN_CHAINS.find((c) => c.key === 'doge')!, rpcUrls: [] }
  await legacyUtxoAdapter(doge, UTXO_COINS.doge!, { fetch: fetchFn, blockcypher: true }).getBalances('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', [])
  assert.deepEqual(asked, ['api.blockcypher.com'])
})

// ---- coins and keys ----

test('a chain that is not a built-in Bitcoin-family coin has no built-in token', () => {
  assert.equal(builtinNativeToken('eth'), undefined)
})

test('a built-in coin’s token has 8 decimals and LI.FI’s name for its address', () => {
  assert.deepEqual(builtinNativeToken('doge'), { chainKey: 'doge', address: 'dogecoin', symbol: 'DOGE', decimals: 8 })
})

test('a key for a coin the app does not know is refused by name', () => {
  assert.throws(() => utxoKey(mnemonicToSeedSync(MNEMONIC), 'zec'), /^Error: No Bitcoin-family coin "zec"$/)
})

test('EVM chains share one address slot', () => {
  assert.equal(addressSlot({ family: 'evm', key: 'arb' }), 'evm')
})

test('other chains keep their address under their own key', () => {
  assert.equal(addressSlot({ family: 'bitcoin', key: 'ltc' }), 'ltc')
})

test('a key-only wallet has no address on a non-EVM chain, and says how to get one', () => {
  assert.throws(() => chainAddress({ evm: mnemonicToAccount(MNEMONIC) }, { family: 'solana', key: 'sol' }), /^Error: This wallet was made from a single EVM private key and has no address on other chains\. Import a seed phrase to use them\.$/)
})

// ---- gas estimates ----

const evmChain = (rpcUrls: string[]): Chain => ({ family: 'evm', key: 'eth', id: 1, name: 'Ethereum', nativeSymbol: 'ETH', rpcUrls, testnet: false, nativePriceUsd: 3000 })
/** JSON-RPC nodes by host: a gas price in wei, or a failure. */
const gasNodes = (answers: Record<string, string | 'down'>) =>
  (async (url: string, init?: RequestInit) => {
    const a = answers[new URL(url).host]
    if (a === 'down' || a === undefined) return new Response('down', { status: 503 })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init!.body)).id, result: a }))
  }) as typeof fetch

test('the gas estimate moves on to the next node when one fails', async () => {
  // 10 gwei x 150 000 gas = 0.0015 ETH x $3 000 = $4.50
  assert.equal(await estimateGasUsd(evmChain(['https://a.node', 'https://b.node']), gasNodes({ 'a.node': 'down', 'b.node': '0x2540be400' })), 4.5)
})

test('the gas estimate is unknown when every node fails', async () => {
  assert.equal(await estimateGasUsd(evmChain(['https://a.node', 'https://b.node']), gasNodes({ 'a.node': 'down', 'b.node': 'down' })), undefined)
})

test('the gas estimate is unknown without a coin price', async () => {
  assert.equal(await estimateGasUsd({ ...evmChain(['https://a.node']), nativePriceUsd: undefined }, gasNodes({ 'a.node': '0x1' })), undefined)
})

test('the gas estimate is unknown for a chain without endpoints', async () => {
  assert.equal(await estimateGasUsd(evmChain([]), gasNodes({})), undefined)
})

test('the gas estimate is only made for EVM chains', async () => {
  assert.equal(await estimateGasUsd({ ...evmChain(['https://a.node']), family: 'solana' }, gasNodes({ 'a.node': '0x1' })), undefined)
})

test('a top-up switched off has no value and no reason', () => {
  assert.deepEqual(gasTopUpUsd({ ...defaultSettings.gasTopUp, mode: 'off' }, 1), {})
})

// ---- ranking and chains ----

const q = (toAmount: bigint, etaSeconds: number, extra: Partial<Quote> = {}) => ({ provider: 'x', tool: `t${toAmount}-${etaSeconds}`, request: { from: { chainKey: 'a', address: '0x', symbol: 'X', decimals: 6 }, to: { chainKey: 'b', address: '0x', symbol: 'X', decimals: 6 }, amount: 1n, fromAddress: '', toAddress: '', slippage: 0 }, toAmount, toAmountMin: toAmount, costUsd: 0, etaSeconds, viaSymbols: [], raw: null, statusRef: {}, ...extra }) as Quote

test('without prices, the larger amount ranks first', () => {
  assert.deepEqual(rankQuotes([q(5n, 10), q(7n, 10)], 'cheapest').map((x) => x.toAmount), [7n, 5n])
})

test('equal amounts without prices are ordered by speed when cheapest is wanted', () => {
  assert.deepEqual(rankQuotes([q(5n, 90), q(5n, 30)], 'cheapest').map((x) => x.etaSeconds), [30, 90])
})

test('equally fast routes are ordered by value when fastest is wanted', () => {
  assert.deepEqual(rankQuotes([q(5n, 30), q(9n, 30)], 'fastest').map((x) => x.toAmount), [9n, 5n])
})

test('a fastest search puts speed before value', () => {
  assert.deepEqual(rankQuotes([q(9n, 90), q(5n, 30)], 'fastest').map((x) => x.etaSeconds), [30, 90])
})

const chains: Chain[] = [
  { family: 'evm', key: 'arb', id: 42161, name: 'Arbitrum', nativeSymbol: 'ETH', rpcUrls: [], testnet: false },
  { family: 'evm', key: 'arbs', id: 421614, name: 'Arbitrum Sepolia', nativeSymbol: 'ETH', rpcUrls: [], testnet: true },
  { family: 'evm', key: 'opt', id: 10, name: 'OP Mainnet', nativeSymbol: 'ETH', rpcUrls: [], testnet: false },
  { family: 'evm', key: 'base', id: 8453, name: 'Base', nativeSymbol: 'ETH', rpcUrls: [], testnet: false },
  { family: 'evm', key: 'bast', id: 84532, name: 'Base Sepolia', nativeSymbol: 'ETH', rpcUrls: [], testnet: true },
  { family: 'evm', key: 'mnt', id: 5000, name: 'Mantle', nativeSymbol: 'MNT', rpcUrls: [], testnet: false },
  { family: 'evm', key: 'mntt', id: 5003, name: 'Mantle Sepolia', nativeSymbol: 'MNT', rpcUrls: [], testnet: true },
]

test('a partial name that fits a mainnet and its testnet picks the mainnet', () => {
  assert.equal(findChain(chains, 'arbi').key, 'arb')
})

test('a partial name that fits only test networks still finds a unique one', () => {
  assert.equal(findChain(chains, 'base sep').key, 'bast')
})

test('a partial name that fits several chains lists them all', () => {
  assert.throws(() => findChain(chains, 'sepolia'), /^Error: "sepolia" matches several chains: Arbitrum Sepolia \(arbs\), Base Sepolia \(bast\), Mantle Sepolia \(mntt\)$/)
})

test('a common nickname finds the chain by its key', () => {
  assert.equal(findChain(chains, 'Optimism').key, 'opt')
})

test('a chain id finds the chain', () => {
  assert.equal(findChain(chains, '5000').key, 'mnt')
})

test('a name that fits nothing points to the chain list', () => {
  assert.throws(() => findChain(chains, 'atlantis'), /^Error: Unknown chain "atlantis"\. Run "chainer chains" to list them\.$/)
})

// ---- optional packages ----

const missing = (code: string, pkg: string) => async () => {
  throw Object.assign(new Error(`Cannot find module '${pkg}'`), { code })
}

test('a package missing under CommonJS rules counts as not installed', async () => {
  assert.equal(await loadSdk('@atomiqlabs/sdk', missing('MODULE_NOT_FOUND', '@atomiqlabs/sdk')), undefined)
})

test('a missing dependency of the package counts as broken, not as not installed', async () => {
  // The package is there but something it imports is not: its name is not the one asked for.
  await assert.rejects(loadSdk('@atomiqlabs/sdk', missing('ERR_MODULE_NOT_FOUND', 'bn.js')), /^Error: The optional package @atomiqlabs\/sdk is installed but could not be loaded: Cannot find module 'bn\.js'$/)
})

test('a broken optional package is listed as not installed, with the reason', async () => {
  const [atomiq] = await sdkStatus(async () => {
    throw new Error('Unexpected token')
  })
  assert.deepEqual([atomiq!.installed, atomiq!.error], [false, 'The optional package @atomiqlabs/sdk is installed but could not be loaded: Unexpected token'])
})

test('an optional SDK counts as installed only when all its packages are', async () => {
  const [atomiq] = await sdkStatus(async (pkg) => {
    if (pkg === '@solana/web3.js') throw Object.assign(new Error(`Cannot find package '${pkg}'`), { code: 'ERR_MODULE_NOT_FOUND' })
    return {}
  })
  assert.equal(atomiq!.installed, false)
})

// ---- default endpoints ----

test('an endpoint LI.FI lists that is not a URL is kept as it is', () => {
  assert.deepEqual(defaultRpcUrls({ family: 'evm', id: 999_999 }, ['not a url', 'https://mainnet.base.org']), ['not a url'])
})

// ---- saved routes ----

test('a saved route name with a slash is not looked up', async () => {
  await assert.rejects(loadRoute(memoryStore(), 'a/b'), /^Error: No saved route "a\/b"/)
})

test('removing a route that was never saved says so', async () => {
  await assert.rejects(removeRoute(memoryStore(), 'nightly'), /^Error: No saved route "nightly"$/)
})

test('removing a route with an unusable name says there is none', async () => {
  await assert.rejects(removeRoute(memoryStore(), '../keystore'), /^Error: No saved route "\.\.\/keystore"$/)
})

test('a saved route with the fallback allowed but nothing found at all stops', () => {
  assert.throws(() => chooseSaved({ via: 'lifi/across', fallback: true }, []), /^Error: No route found at the moment$/)
})

// ---- transit wallets ----

const route = (toAddress: string): Route => ({ legs: [q(1n, 1, { request: { ...q(1n, 1).request, toAddress } })] })

test('an address of a stored transit wallet counts as a transit address', async () => {
  const store = fastStore()
  const record = await addAccount(store, 'transit-arb-1', MNEMONIC, 'password1', { chainKey: 'arb', createdAt: '2026-11-26T00:00:00Z' })
  assert.equal(new TransitPool((await loadKeystore(store)).accounts).isTransit(record.addresses.evm), true)
})

test('a new transit wallet on a chain that has one is numbered after it', async () => {
  const store = fastStore()
  await addAccount(store, 'main', MNEMONIC, 'password1')
  await addAccount(store, 'transit-arb-1', 'legal winner thank year wave sausage worth useful legal winner thank yellow', 'password1', { chainKey: 'arb', createdAt: '2026-11-26T00:00:00Z' })
  // A pool that does not know the stored one (as when the route was searched before it was saved).
  const pool = new TransitPool([])
  const address = pool.addressOn({ family: 'evm', key: 'arb' })
  await persistTransit(store, pool, route(address), async () => 'password1')
  assert.deepEqual((await loadKeystore(store)).accounts.map((a) => a.name), ['main', 'transit-arb-1', 'transit-arb-2'])
})

// ---- Atomiq file storage ----

test('a swap file that cannot be read for another reason than being absent is reported, not treated as empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chainer-branch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'store.json'))
  await assert.rejects(new FileUnifiedStorage(join(dir, 'store.json')).init([]), { code: 'EISDIR' })
})

test('without prices, the larger amount ranks first whichever order the routes came in', () => {
  assert.deepEqual(rankQuotes([q(7n, 10), q(5n, 10), q(9n, 10)], 'cheapest').map((x) => x.toAmount), [9n, 7n, 5n])
})

test('an import error without any message counts as a broken package', async () => {
  await assert.rejects(loadSdk('@atomiqlabs/sdk', async () => {
    throw { code: 'ERR_MODULE_NOT_FOUND' }
  }), /is installed but could not be loaded/)
})
