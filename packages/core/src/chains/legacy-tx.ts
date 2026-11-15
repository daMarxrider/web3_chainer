import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { createBase58check } from '@scure/base'
import type { UtxoCoin } from './utxo-coins.ts'

// Plain pay-to-pubkey-hash transactions for the coins without SegWit (Dogecoin, Dash, Bitcoin Cash).

const b58c = createBase58check(sha256)
const sha256d = (data: Uint8Array) => sha256(sha256(data))
export const hash160 = (data: Uint8Array) => ripemd160(sha256(data))

const u32 = (n: number) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
const u64 = (n: bigint) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
  return b
}
const varint = (n: number) => (n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 0xff, n >> 8))
const withLength = (b: Uint8Array) => concatBytes(varint(b.length), b)
const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))
export const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const push = (data: Uint8Array) => concatBytes(Uint8Array.of(data.length), data)

// ---- CashAddr (Bitcoin Cash) ---------------------------------------------

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n]

function polymod(values: number[]): bigint {
  let c = 1n
  for (const d of values) {
    const top = c >> 35n
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d)
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) c ^= GEN[i]!
  }
  return c ^ 1n
}
const prefixBits = (prefix: string) => [...[...prefix].map((ch) => ch.charCodeAt(0) & 0x1f), 0]

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const v of data) {
    acc = (acc << from) | v
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & ((1 << to) - 1))
    }
    acc &= (1 << bits) - 1
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1))
  if (!pad && (bits >= from || acc !== 0)) throw new Error('Bad CashAddr padding')
  return out
}

export type AddressType = 'p2pkh' | 'p2sh'
export interface DecodedAddress {
  type: AddressType
  hash: Uint8Array
}

export function cashAddrEncode(prefix: string, type: AddressType, hash: Uint8Array): string {
  if (hash.length !== 20) throw new Error('Only 160-bit CashAddr hashes are supported')
  const payload = convertBits([type === 'p2pkh' ? 0 : 8, ...hash], 8, 5, true)
  const sum = polymod([...prefixBits(prefix), ...payload, 0, 0, 0, 0, 0, 0, 0, 0])
  const checksum = Array.from({ length: 8 }, (_, i) => Number((sum >> BigInt(5 * (7 - i))) & 31n))
  return `${prefix}:${[...payload, ...checksum].map((d) => CHARSET[d]).join('')}`
}

export function cashAddrDecode(prefix: string, address: string): DecodedAddress {
  const lower = address.toLowerCase()
  if (lower !== address && address.toUpperCase() !== address) throw new Error('CashAddr must not mix upper and lower case')
  const [p, body] = lower.includes(':') ? (lower.split(':') as [string, string]) : [prefix, lower]
  if (p !== prefix) throw new Error(`Not a ${prefix} address`)
  const values = [...body].map((ch) => CHARSET.indexOf(ch))
  if (values.length < 9 || values.includes(-1)) throw new Error('Bad CashAddr characters')
  if (polymod([...prefixBits(prefix), ...values]) !== 0n) throw new Error('Bad CashAddr checksum')
  const bytes = convertBits(values.slice(0, -8), 5, 8, false)
  const version = bytes[0]!
  if ((version & 7) !== 0 || bytes.length !== 21 || (version >> 3) > 1) throw new Error('Unsupported CashAddr type or size')
  return { type: version >> 3 === 0 ? 'p2pkh' : 'p2sh', hash: Uint8Array.from(bytes.slice(1)) }
}

// ---- Addresses and scripts -----------------------------------------------

export function addressCodec(coin: UtxoCoin) {
  const { pubKeyHash, scriptHash } = coin.network
  return {
    encode(hash: Uint8Array, type: AddressType = 'p2pkh'): string {
      if (coin.cashAddrPrefix) return cashAddrEncode(coin.cashAddrPrefix, type, hash)
      return b58c.encode(concatBytes(Uint8Array.of(type === 'p2pkh' ? pubKeyHash : scriptHash), hash))
    },
    decode(address: string): DecodedAddress {
      if (coin.cashAddrPrefix) {
        try {
          return cashAddrDecode(coin.cashAddrPrefix, address)
        } catch {
          // The older Base58 form of the same addresses is accepted too.
        }
      }
      const raw = b58c.decode(address)
      if (raw.length !== 21) throw new Error('Bad address length')
      if (raw[0] === pubKeyHash) return { type: 'p2pkh', hash: raw.slice(1) }
      if (raw[0] === scriptHash) return { type: 'p2sh', hash: raw.slice(1) }
      throw new Error(`Not a ${coin.name} address`)
    },
  }
}

export function outputScript({ type, hash }: DecodedAddress): Uint8Array {
  return type === 'p2pkh'
    ? concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac))
    : concatBytes(Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87))
}

export const dataScript = (data: Uint8Array) => concatBytes(Uint8Array.of(0x6a), data.length < 76 ? Uint8Array.of(data.length) : Uint8Array.of(0x4c, data.length), data)

// ---- Transactions --------------------------------------------------------

export interface LegacyInput {
  txid: string
  vout: number
  /** Value of the coin being spent; Bitcoin Cash signatures commit to it. */
  value: bigint
  /** Script of the coin being spent. */
  script: Uint8Array
}
export interface LegacyOutput {
  script: Uint8Array
  amount: bigint
}

const SEQUENCE = 0xffffffff
const VERSION = 1
const SIGHASH_ALL = 1
const SIGHASH_FORKID = 0x40

const outpoint = (i: LegacyInput) => concatBytes(hexToBytes(i.txid).reverse(), u32(i.vout))
const serializeOutput = (o: LegacyOutput) => concatBytes(u64(o.amount), withLength(o.script))

/** Digest the signature of input `index` commits to. With `forkId` (Bitcoin Cash) it also commits to the amounts, as BIP-143 does. */
export function sighash(inputs: LegacyInput[], outputs: LegacyOutput[], index: number, forkId: boolean): Uint8Array {
  const input = inputs[index]!
  if (forkId) {
    const hashType = SIGHASH_ALL | SIGHASH_FORKID
    return sha256d(
      concatBytes(
        u32(VERSION),
        sha256d(concatBytes(...inputs.map(outpoint))),
        sha256d(concatBytes(...inputs.map(() => u32(SEQUENCE)))),
        outpoint(input),
        withLength(input.script),
        u64(input.value),
        u32(SEQUENCE),
        sha256d(concatBytes(...outputs.map(serializeOutput))),
        u32(0),
        u32(hashType),
      ),
    )
  }
  return sha256d(
    concatBytes(
      u32(VERSION),
      varint(inputs.length),
      ...inputs.map((inp, i) => concatBytes(outpoint(inp), withLength(i === index ? input.script : new Uint8Array()), u32(SEQUENCE))),
      varint(outputs.length),
      ...outputs.map(serializeOutput),
      u32(0),
      u32(SIGHASH_ALL),
    ),
  )
}

/** Signs every input (all must be pay-to-pubkey-hash coins of the key) and returns the raw transaction. */
export function signLegacyTx(opts: { inputs: LegacyInput[]; outputs: LegacyOutput[]; privateKey: Uint8Array; publicKey: Uint8Array; forkId: boolean }): Uint8Array {
  const { inputs, outputs, privateKey, publicKey, forkId } = opts
  const hashType = forkId ? SIGHASH_ALL | SIGHASH_FORKID : SIGHASH_ALL
  const scriptSigs = inputs.map((_, i) => {
    const sig = secp256k1.sign(sighash(inputs, outputs, i, forkId), privateKey, { prehash: false, lowS: true, format: 'der' })
    return concatBytes(push(concatBytes(sig, Uint8Array.of(hashType))), push(publicKey))
  })
  return concatBytes(
    u32(VERSION),
    varint(inputs.length),
    ...inputs.map((inp, i) => concatBytes(outpoint(inp), withLength(scriptSigs[i]!), u32(SEQUENCE))),
    varint(outputs.length),
    ...outputs.map(serializeOutput),
    u32(0),
  )
}
