import { generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { bytesToHex, hexToBytes, isHex, type Hex } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import type { Signer, Store } from './types.ts'

export interface AccountRecord {
  name: string
  /** "seed" derives a key for every chain family; "key" is one imported private key. */
  type: 'seed' | 'key'
  /** Public addresses, readable without the password. */
  addresses: { evm: string }
  iv: Hex
  data: Hex
}

export interface Keystore {
  version: 1
  salt: Hex
  iterations: number
  accounts: AccountRecord[]
}

const KEY = 'keystore.json'
const ITERATIONS = 600_000
const text = new TextEncoder()

export const newMnemonic = () => generateMnemonic(wordlist, 128)

export async function loadKeystore(store: Store): Promise<Keystore> {
  const raw = await store.get(KEY)
  if (raw) return JSON.parse(raw) as Keystore
  return {
    version: 1,
    salt: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    iterations: ITERATIONS,
    accounts: [],
  }
}

async function deriveKey(keystore: Keystore, password: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', text.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: hexToBytes(keystore.salt) as BufferSource, iterations: keystore.iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function decrypt(keystore: Keystore, record: AccountRecord, password: string): Promise<string> {
  const key = await deriveKey(keystore, password)
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(record.iv) as BufferSource },
      key,
      hexToBytes(record.data) as BufferSource,
    )
    return new TextDecoder().decode(plain)
  } catch {
    throw new Error('Wrong password')
  }
}

function signerFromSecret(secret: string): { type: AccountRecord['type']; signer: Signer } {
  if (isHex(secret)) {
    if (secret.length !== 66) throw new Error('A private key must be 32 bytes (0x followed by 64 hex characters)')
    return { type: 'key', signer: { evm: privateKeyToAccount(secret) } }
  }
  if (!validateMnemonic(secret, wordlist)) throw new Error('Not a valid private key or BIP-39 seed phrase')
  return { type: 'seed', signer: { evm: mnemonicToAccount(secret) } }
}

/** Normalises user input: trims, collapses whitespace in seed phrases, adds 0x to bare hex keys. */
export function normalizeSecret(input: string): string {
  const s = input.trim().replace(/\s+/g, ' ')
  return /^[0-9a-fA-F]{64}$/.test(s) ? `0x${s}` : s
}

/** Encrypts a seed phrase or private key under the keystore password and saves it. */
export async function addAccount(store: Store, name: string, secretInput: string, password: string): Promise<AccountRecord> {
  const keystore = await loadKeystore(store)
  if (keystore.accounts.some((a) => a.name === name)) throw new Error(`A wallet named "${name}" already exists`)
  // One password for the whole keystore: check it against an existing account.
  if (keystore.accounts.length > 0) await decrypt(keystore, keystore.accounts[0]!, password)
  if (password.length < 8) throw new Error('Password must be at least 8 characters')

  const secret = normalizeSecret(secretInput)
  const { type, signer } = signerFromSecret(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(keystore, password)
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, text.encode(secret))
  const record: AccountRecord = {
    name,
    type,
    addresses: { evm: signer.evm.address },
    iv: bytesToHex(iv),
    data: bytesToHex(new Uint8Array(data)),
  }
  keystore.accounts.push(record)
  await store.set(KEY, JSON.stringify(keystore, null, 2))
  return record
}

/** Picks the named account, or the only/first one when no name is given. */
export function findAccount(keystore: Keystore, name?: string): AccountRecord {
  if (keystore.accounts.length === 0) throw new Error('No wallet yet. Create one with "chainer wallet init" or "chainer wallet import".')
  const record = name ? keystore.accounts.find((a) => a.name === name) : keystore.accounts[0]
  if (!record) throw new Error(`No wallet named "${name}"`)
  return record
}

export async function unlock(store: Store, name: string | undefined, password: string): Promise<Signer> {
  const keystore = await loadKeystore(store)
  const record = findAccount(keystore, name)
  return signerFromSecret(await decrypt(keystore, record, password)).signer
}
