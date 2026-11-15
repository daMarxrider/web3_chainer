import { ed25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { base58 } from '@scure/base'
import { HDKey } from '@scure/bip32'
import * as btc from '@scure/btc-signer'
import { addressCodec, hash160 } from './chains/legacy-tx.ts'
import { UTXO_COINS } from './chains/utxo-coins.ts'
import type { Chain, Signer } from './types.ts'

/** SLIP-0010 ed25519 derivation (hardened steps only). */
function slip10(seed: Uint8Array, path: number[]): Uint8Array {
  let node = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed)
  for (const index of path) {
    const data = new Uint8Array(37)
    data.set(node.subarray(0, 32), 1)
    new DataView(data.buffer).setUint32(33, (index | 0x80000000) >>> 0)
    node = hmac(sha512, node.subarray(32), data)
  }
  return node.slice(0, 32)
}

/** Phantom, Solflare and Backpack default: m/44'/501'/0'/0'. */
export const solanaSecretKey = (seed: Uint8Array) => slip10(seed, [44, 501, 0, 0])
export const solanaAddress = (secret: Uint8Array) => base58.encode(ed25519.getPublicKey(secret))

/** First address of the account: native SegWit (BIP-84, m/84'/<coin>'/0'/0/0) or, for coins without SegWit, pay-to-pubkey-hash (BIP-44, m/44'/…). */
export function utxoKey(seed: Uint8Array, chainKey: string): { privateKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const coin = UTXO_COINS[chainKey]
  if (!coin) throw new Error(`No Bitcoin-family coin "${chainKey}"`)
  const node = HDKey.fromMasterSeed(seed).derive(`m/${coin.legacy ? 44 : 84}'/${coin.coinType}'/0'/0/0`)
  const address = coin.legacy ? addressCodec(coin).encode(hash160(node.publicKey!)) : btc.p2wpkh(node.publicKey!, coin.network).address!
  return { privateKey: node.privateKey!, publicKey: node.publicKey!, address }
}

/** The key under which a chain's address is stored in a wallet: one EVM address serves every EVM chain. */
export const addressSlot = (chain: Pick<Chain, 'family' | 'key'>) => (chain.family === 'evm' ? 'evm' : chain.key)

/** Address of the wallet on a chain, derived from its keys. */
export function chainAddress(signer: Signer, chain: Pick<Chain, 'family' | 'key'>): string {
  if (chain.family === 'evm') return signer.evm.address
  if (!signer.seed) {
    throw new Error('This wallet was made from a single EVM private key and has no address on other chains. Import a seed phrase to use them.')
  }
  if (chain.family === 'solana') return solanaAddress(solanaSecretKey(signer.seed))
  return utxoKey(signer.seed, chain.key).address
}

/** Addresses stored with a wallet so they can be listed without the password. */
export function walletAddresses(signer: Signer): Record<string, string> {
  const addresses: Record<string, string> = { evm: signer.evm.address }
  if (signer.seed) {
    addresses.sol = solanaAddress(solanaSecretKey(signer.seed))
    addresses.sold = addresses.sol
    for (const key of Object.keys(UTXO_COINS)) addresses[key] = utxoKey(signer.seed, key).address
  }
  return addresses
}
