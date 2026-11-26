import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { createBase58check } from '@scure/base'
import { addressCodec, cashAddrDecode, cashAddrEncode, dataScript, outputScript, signLegacyTx, UTXO_COINS, utxoKey } from '../src/index.ts'
import { mnemonicToSeedSync } from '@scure/bip39'

const b58c = createBase58check(sha256)
const hash20 = Uint8Array.from({ length: 20 }, (_, i) => i + 1)

/**
 * A CashAddr encoder written from the specification (BCH CashAddr, "polymod" checksum), used only
 * to build malformed but correctly checksummed inputs the app must refuse: a reserved type, or a
 * payload with bad padding bits.
 */
function specCashAddr(prefix: string, payload5: number[]): string {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const G = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n]
  const polymod = (v: number[]) => {
    let c = 1n
    for (const d of v) {
      const c0 = c >> 35n
      c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d)
      for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= G[i]!
    }
    return c ^ 1n
  }
  const mod = polymod([...[...prefix].map((ch) => ch.charCodeAt(0) & 31), 0, ...payload5, 0, 0, 0, 0, 0, 0, 0, 0])
  const checksum = Array.from({ length: 8 }, (_, i) => Number((mod >> BigInt(5 * (7 - i))) & 31n))
  return `${prefix}:${[...payload5, ...checksum].map((d) => CHARSET[d]).join('')}`
}
/** 8-bit bytes to 5-bit groups, padded with zero bits (or with the given last group to break the padding). */
function to5(bytes: number[], lastGroup?: number): number[] {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push((acc >> bits) & 31)
    }
  }
  if (bits > 0) out.push(lastGroup ?? ((acc << (5 - bits)) & 31))
  return out
}

// ---- CashAddr ----

const VALID = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'

test('a CashAddr without its prefix is read with the expected prefix', () => {
  assert.deepEqual(cashAddrDecode('bitcoincash', VALID.slice('bitcoincash:'.length)), cashAddrDecode('bitcoincash', VALID))
})

test('a CashAddr written all in capitals is accepted', () => {
  assert.deepEqual(cashAddrDecode('bitcoincash', VALID.toUpperCase()), cashAddrDecode('bitcoincash', VALID))
})

test('a CashAddr mixing capitals and lower case is refused', () => {
  assert.throws(() => cashAddrDecode('bitcoincash', 'bitcoincash:Qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'), /^Error: CashAddr must not mix upper and lower case$/)
})

test('a CashAddr for another network is refused', () => {
  assert.throws(() => cashAddrDecode('bitcoincash', 'bchtest:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'), /^Error: Not a bitcoincash address$/)
})

test('a CashAddr with a letter outside its alphabet is refused', () => {
  // "b" is not in the CashAddr alphabet.
  assert.throws(() => cashAddrDecode('bitcoincash', 'bitcoincash:bpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'), /^Error: Bad CashAddr characters$/)
})

test('a CashAddr too short to hold a checksum is refused', () => {
  assert.throws(() => cashAddrDecode('bitcoincash', 'bitcoincash:qpm2qszn'), /^Error: Bad CashAddr characters$/)
})

test('a CashAddr with a wrong checksum is refused', () => {
  assert.throws(() => cashAddrDecode('bitcoincash', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6q'), /^Error: Bad CashAddr checksum$/)
})

test('a CashAddr of a reserved type is refused', () => {
  // Version byte 0x10 = type 2, which the app does not support; checksum correct.
  assert.throws(() => cashAddrDecode('bitcoincash', specCashAddr('bitcoincash', to5([0x10, ...hash20]))), /^Error: Unsupported CashAddr type or size$/)
})

test('a CashAddr whose padding bits are not zero is refused', () => {
  // 21 bytes = 168 bits = 33 full groups + 3 bits; the last group carries non-zero padding.
  assert.throws(() => cashAddrDecode('bitcoincash', specCashAddr('bitcoincash', to5([0x00, ...hash20], 0b00111))), /^Error: Bad CashAddr padding$/)
})

test('a CashAddr for a hash other than 160 bits is not made', () => {
  assert.throws(() => cashAddrEncode('bitcoincash', 'p2pkh', new Uint8Array(32)), /^Error: Only 160-bit CashAddr hashes are supported$/)
})

test('Bitcoin Cash also takes the older Base58 form of an address', () => {
  // Version byte 0 is Bitcoin Cash's (and Bitcoin's) legacy pay-to-pubkey-hash.
  assert.deepEqual(addressCodec(UTXO_COINS.bch!).decode(b58c.encode(Uint8Array.of(0, ...hash20))), { type: 'p2pkh', hash: hash20 })
})

// ---- Base58 addresses ----

const doge = addressCodec(UTXO_COINS.doge!)

test('a Dogecoin pay-to-script-hash address is made and read back', () => {
  const address = doge.encode(hash20, 'p2sh')
  assert.deepEqual(doge.decode(address), { type: 'p2sh', hash: hash20 })
})

test('a Bitcoin address is not a Dogecoin address', () => {
  assert.throws(() => doge.decode(b58c.encode(Uint8Array.of(0, ...hash20))), /^Error: Not a Dogecoin address$/)
})

test('a Base58 address of the wrong length is refused', () => {
  assert.throws(() => doge.decode(b58c.encode(Uint8Array.of(0x1e, ...hash20, 0))), /^Error: Bad address length$/)
})

// ---- scripts ----

test('a pay-to-script-hash output is OP_HASH160 <hash> OP_EQUAL', () => {
  assert.deepEqual(outputScript({ type: 'p2sh', hash: hash20 }), Uint8Array.of(0xa9, 0x14, ...hash20, 0x87))
})

test('a data output of up to 75 bytes is pushed with a one-byte length', () => {
  assert.deepEqual(dataScript(new Uint8Array(75)).slice(0, 2), Uint8Array.of(0x6a, 75))
})

test('a data output of 76 bytes or more is pushed with OP_PUSHDATA1', () => {
  assert.deepEqual(dataScript(new Uint8Array(80)).slice(0, 3), Uint8Array.of(0x6a, 0x4c, 80))
})

// ---- transactions ----

test('a transaction with 253 inputs writes the count as a three-byte number', () => {
  const key = utxoKey(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), 'doge')
  const own = outputScript(doge.decode(key.address))
  const inputs = Array.from({ length: 253 }, (_, i) => ({ txid: 'aa'.repeat(32), vout: i, value: 1_000_000n, script: own }))
  const raw = signLegacyTx({ inputs, outputs: [{ script: own, amount: 1n }], privateKey: key.privateKey, publicKey: key.publicKey, forkId: false })
  // After the 4-byte version: 0xfd, then 253 as little-endian 16 bits.
  assert.deepEqual(raw.slice(4, 7), Uint8Array.of(0xfd, 0xfd, 0x00))
})
