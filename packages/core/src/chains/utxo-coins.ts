import * as btc from '@scure/btc-signer'
import type { Chain } from '../types.ts'

/** What differs between Bitcoin-family coins: address format, key derivation and where to read the chain. */
export interface UtxoCoin {
  chainKey: string
  /** BIP-44 coin type used in m/84'/<type>'/0'/0/0. */
  coinType: number
  network: typeof btc.NETWORK
  /** Esplora-compatible REST endpoints (the format of mempool.space/api). */
  esplora: string[]
  /** Smallest output worth creating; below this the change is added to the fee. */
  dust: bigint
}

const LITECOIN = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 }

export const UTXO_COINS: Record<string, UtxoCoin> = {
  btc: { chainKey: 'btc', coinType: 0, network: btc.NETWORK, esplora: ['https://mempool.space/api'], dust: 546n },
  ltc: { chainKey: 'ltc', coinType: 2, network: LITECOIN, esplora: ['https://litecoinspace.org/api'], dust: 546n },
  // Test networks have no LI.FI entry, so they are defined here. Bitcoin testnet4 and signet share addresses.
  btct: { chainKey: 'btct', coinType: 1, network: btc.TEST_NETWORK, esplora: ['https://mempool.space/testnet4/api'], dust: 546n },
}

/** Chains the app knows without asking a route source: the Bitcoin-family and Solana test networks. */
export const BUILTIN_TEST_CHAINS: Chain[] = [
  { family: 'bitcoin', key: 'btct', id: 20000000000101, name: 'Bitcoin Testnet4', nativeSymbol: 'tBTC', rpcUrls: UTXO_COINS.btct!.esplora, testnet: true },
  { family: 'solana', key: 'sold', id: 1151111081099711, name: 'Solana Devnet', nativeSymbol: 'SOL', rpcUrls: ['https://api.devnet.solana.com'], testnet: true },
]
