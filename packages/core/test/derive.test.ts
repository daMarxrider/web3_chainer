import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mnemonicToSeedSync } from '@scure/bip39'
import { mnemonicToAccount } from 'viem/accounts'
import { chainAddress, walletAddresses, type Chain, type Signer } from '../src/index.ts'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const signer: Signer = { evm: mnemonicToAccount(MNEMONIC), seed: mnemonicToSeedSync(MNEMONIC) }
const chain = (family: Chain['family'], key: string) => ({ family, key })

test('Bitcoin address matches the BIP-84 test vector', () => {
  assert.equal(chainAddress(signer, chain('bitcoin', 'btc')), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')
})

test('Solana address matches the standard wallet derivation', () => {
  assert.equal(chainAddress(signer, chain('solana', 'sol')), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')
})

test('Litecoin and testnet addresses use their own prefixes', () => {
  assert.match(chainAddress(signer, chain('bitcoin', 'ltc')), /^ltc1q/)
  assert.match(chainAddress(signer, chain('bitcoin', 'btct')), /^tb1q/)
})

test('a wallet from a single EVM key has no address on other families', () => {
  const keyOnly: Signer = { evm: signer.evm }
  assert.equal(chainAddress(keyOnly, chain('evm', 'arb')), signer.evm.address)
  assert.throws(() => chainAddress(keyOnly, chain('solana', 'sol')), /single EVM private key/)
  assert.deepEqual(Object.keys(walletAddresses(keyOnly)), ['evm'])
})
