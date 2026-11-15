import * as btc from '@scure/btc-signer'
import type { Chain, Token } from '../types.ts'

/** Where a coin's balances, coins to spend, fees and broadcasts come from. */
export type UtxoBackend = 'esplora' | 'blockcypher' | 'bch-rest'

/** What differs between Bitcoin-family coins: address format, key derivation and where to read the chain. */
export interface UtxoCoin {
  chainKey: string
  name: string
  symbol: string
  /** BIP-44 coin type in the key path. */
  coinType: number
  /** SegWit coins use native SegWit (m/84'), legacy coins plain pay-to-pubkey-hash (m/44'). */
  legacy: boolean
  network: typeof btc.NETWORK
  backend: UtxoBackend
  /** Root URLs of the data source (Esplora: mempool.space/api format; others: the API root of their backend). */
  endpoints: string[]
  /** Smallest output worth creating; below this the change is added to the fee. */
  dust: bigint
  /** Fee ceiling on top of 5 % of the amount, so a broken fee estimate cannot burn the amount. */
  maxFeeFloor: bigint
  /** Fee rate used when the data source gives none, and the floor under its estimate, in smallest units per byte. */
  minFeeRate: number
  /** Bitcoin Cash: addresses are CashAddr and signatures commit to the amount with the fork id. */
  cashAddrPrefix?: string
}

const LITECOIN = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 }
const DOGECOIN = { bech32: '', pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e }
const DASH = { bech32: '', pubKeyHash: 0x4c, scriptHash: 0x10, wif: 0xcc }
const BITCOIN_CASH = { bech32: '', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 }

const segwit = (c: Pick<UtxoCoin, 'chainKey' | 'name' | 'symbol' | 'coinType' | 'network' | 'endpoints'>): UtxoCoin => ({
  ...c,
  legacy: false,
  backend: 'esplora',
  dust: 546n,
  maxFeeFloor: 5_000n,
  minFeeRate: 1,
})

export const UTXO_COINS: Record<string, UtxoCoin> = {
  btc: segwit({ chainKey: 'btc', name: 'Bitcoin', symbol: 'BTC', coinType: 0, network: btc.NETWORK, endpoints: ['https://mempool.space/api'] }),
  ltc: segwit({ chainKey: 'ltc', name: 'Litecoin', symbol: 'LTC', coinType: 2, network: LITECOIN, endpoints: ['https://litecoinspace.org/api'] }),
  // Test networks have no LI.FI entry, so they are defined here. Bitcoin testnet4 and signet share addresses.
  btct: segwit({ chainKey: 'btct', name: 'Bitcoin Testnet4', symbol: 'tBTC', coinType: 1, network: btc.TEST_NETWORK, endpoints: ['https://mempool.space/testnet4/api'] }),
  // Legacy coins: no SegWit. Dogecoin's relay rules want 0.01 DOGE per kB at least and ignore outputs under 0.01 DOGE.
  doge: {
    chainKey: 'doge', name: 'Dogecoin', symbol: 'DOGE', coinType: 3, legacy: true, network: DOGECOIN, backend: 'blockcypher',
    endpoints: ['https://api.blockcypher.com/v1/doge/main'], dust: 10_000_000n, maxFeeFloor: 500_000_000n, minFeeRate: 1_000,
  },
  dash: {
    chainKey: 'dash', name: 'Dash', symbol: 'DASH', coinType: 5, legacy: true, network: DASH, backend: 'blockcypher',
    endpoints: ['https://api.blockcypher.com/v1/dash/main'], dust: 546n, maxFeeFloor: 100_000n, minFeeRate: 2,
  },
  bch: {
    chainKey: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', coinType: 145, legacy: true, network: BITCOIN_CASH, backend: 'bch-rest',
    endpoints: ['https://rest.bch.actorforth.org/v2'], dust: 546n, maxFeeFloor: 5_000n, minFeeRate: 2, cashAddrPrefix: 'bitcoincash',
  },
}

/** Chain ids made up here; LI.FI (which lists only Bitcoin and Zcash as UTXO chains) takes precedence for any key it knows. */
const BUILTIN_IDS: Record<string, number> = { ltc: 20000000000002, doge: 20000000000003, dash: 20000000000004, bch: 20000000000006, btct: 20000000000101 }

/** Chains the app knows without asking a route source: Bitcoin-family coins LI.FI does not list, and the test networks. */
export const BUILTIN_CHAINS: Chain[] = [
  ...Object.keys(BUILTIN_IDS).map((key): Chain => {
    const coin = UTXO_COINS[key]!
    return { family: 'bitcoin', key, id: BUILTIN_IDS[key]!, name: coin.name, nativeSymbol: coin.symbol, rpcUrls: coin.endpoints, testnet: key === 'btct' }
  }),
  { family: 'solana', key: 'sold', id: 1151111081099711, name: 'Solana Devnet', nativeSymbol: 'SOL', rpcUrls: ['https://api.devnet.solana.com'], testnet: true },
]

const COIN_ADDRESS: Record<string, string> = { btc: 'bitcoin', ltc: 'litecoin', doge: 'dogecoin', dash: 'dash', bch: 'bitcoincash', btct: 'bitcoin' }

/** The native coin of a built-in Bitcoin-family chain, for chains no route source lists tokens for. */
export function builtinNativeToken(chainKey: string): Token | undefined {
  const coin = UTXO_COINS[chainKey]
  return coin ? { chainKey, address: COIN_ADDRESS[chainKey]!, symbol: coin.symbol, decimals: 8 } : undefined
}
