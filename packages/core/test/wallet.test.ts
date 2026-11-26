import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addAccount, findAccount, loadKeystore, normalizeSecret, refreshAddresses, unlock, type Keystore, type Store } from '../src/index.ts'

// ---- fixtures ----

/** BIP-39 test vector; its first Ethereum account (m/44'/60'/0'/0/0) is 0x9858EfFD…Eda94. */
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEED_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
/** Hardhat's first test key; its address is 0xf39Fd6e5…92266. */
const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const KEY_EVM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const PASSWORD = 'correct horse'

/**
 * A store with an empty keystore that derives its key with 1,000 PBKDF2 rounds instead of 600,000,
 * so each test runs in milliseconds. The rounds are read from the file, as with a real keystore.
 */
function fastStore(): Store & { raw: () => string } {
  const data = new Map<string, string>([['keystore.json', JSON.stringify({ version: 1, salt: '0x00112233445566778899aabbccddeeff', iterations: 1000, accounts: [] })]])
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async () => [...data.keys()], raw: () => data.get('keystore.json')! }
}
const emptyStore = (): Store => {
  const data = new Map<string, string>()
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async () => [...data.keys()] }
}

// ---- normalising what the user pastes ----

test('a seed phrase loses surrounding space and inner runs of spaces, tabs and line breaks', () => {
  assert.equal(normalizeSecret('  abandon\tabandon \n abandon  about \n'), 'abandon abandon abandon about')
})

test('a seed phrase typed in capitals is lowered, as the BIP-39 word list is lower case', () => {
  assert.equal(normalizeSecret('Abandon ABANDON about'), 'abandon abandon about')
})

test('a bare 64-digit hex key gets its 0x prefix', () => {
  assert.equal(normalizeSecret(KEY), `0x${KEY}`)
})

test('a bare hex key in capitals gets its prefix and keeps its digits', () => {
  assert.equal(normalizeSecret(KEY.toUpperCase()), `0x${KEY.toUpperCase()}`)
})

test('a key that already has its prefix is left alone', () => {
  assert.equal(normalizeSecret(`0x${KEY}`), `0x${KEY}`)
})

test('63 hex digits are not taken for a key, so they get no prefix', () => {
  assert.equal(normalizeSecret(KEY.slice(1)), KEY.slice(1))
})

// ---- creating wallets ----

test('a new keystore uses 600,000 PBKDF2 rounds and a random 16-byte salt', async () => {
  const [a, b] = [await loadKeystore(emptyStore()), await loadKeystore(emptyStore())]
  assert.deepEqual([a.iterations, a.salt.length, a.salt === b.salt], [600_000, 34, false])
})

test('a wallet from a seed phrase has the seed’s Ethereum address', async () => {
  assert.equal((await addAccount(fastStore(), 'main', SEED, PASSWORD)).addresses.evm, SEED_EVM)
})

test('a wallet from a seed phrase also has Solana and Bitcoin addresses', async () => {
  const record = await addAccount(fastStore(), 'main', SEED, PASSWORD)
  assert.deepEqual([typeof record.addresses.sol, typeof record.addresses.btc], ['string', 'string'])
})

test('a wallet from a seed phrase typed in capitals is the same wallet', async () => {
  assert.equal((await addAccount(fastStore(), 'main', SEED.toUpperCase(), PASSWORD)).addresses.evm, SEED_EVM)
})

test('a wallet from a private key has only its EVM address', async () => {
  const record = await addAccount(fastStore(), 'key', KEY, PASSWORD)
  assert.deepEqual([record.type, Object.keys(record.addresses)], ['key', ['evm']])
})

test('a wallet from a private key has the key’s address', async () => {
  assert.equal((await addAccount(fastStore(), 'key', KEY, PASSWORD)).addresses.evm, KEY_EVM)
})

test('a seed phrase with a wrong checksum word is refused', async () => {
  // Twelve times "abandon" fails the BIP-39 checksum (the valid phrase ends in "about").
  await assert.rejects(addAccount(fastStore(), 'main', Array(12).fill('abandon').join(' '), PASSWORD), /^Error: Not a valid private key or BIP-39 seed phrase$/)
})

test('a private key one byte short is refused with the expected length', async () => {
  await assert.rejects(addAccount(fastStore(), 'key', `0x${KEY.slice(2)}`, PASSWORD), /^Error: A private key must be 32 bytes \(0x followed by 64 hex characters\)$/)
})

test('a private key of all zeros is refused in plain words', async () => {
  await assert.rejects(addAccount(fastStore(), 'key', `0x${'0'.repeat(64)}`, PASSWORD), /^Error: Not a usable private key: it is zero or larger than the curve allows$/)
})

test('a private key above the curve order is refused in plain words', async () => {
  await assert.rejects(addAccount(fastStore(), 'key', `0x${'f'.repeat(64)}`, PASSWORD), /^Error: Not a usable private key: it is zero or larger than the curve allows$/)
})

test('a password of 7 characters is refused', async () => {
  await assert.rejects(addAccount(fastStore(), 'main', SEED, '1234567'), /^Error: Password must be at least 8 characters$/)
})

test('a password of exactly 8 characters is accepted', async () => {
  assert.equal((await addAccount(fastStore(), 'main', SEED, '12345678')).name, 'main')
})

test('a second wallet with a name already used is refused', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  await assert.rejects(addAccount(store, 'main', KEY, PASSWORD), /^Error: A wallet named "main" already exists$/)
})

test('a second wallet needs the keystore’s password', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  await assert.rejects(addAccount(store, 'key', KEY, 'another password'), /^Error: Wrong password$/)
})

test('a second wallet refused for its password leaves the keystore as it was', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  const before = store.raw()
  await assert.rejects(addAccount(store, 'key', KEY, 'another password'), /^Error: Wrong password$/)
  assert.equal(store.raw(), before)
})

test('a second wallet with the right password is added after the first', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  await addAccount(store, 'key', KEY, PASSWORD)
  assert.deepEqual((await loadKeystore(store)).accounts.map((a) => a.name), ['main', 'key'])
})

test('the keystore file holds neither the seed phrase nor the key nor the password', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  await addAccount(store, 'key', KEY, PASSWORD)
  const file = store.raw().toLowerCase()
  assert.deepEqual([file.includes('abandon'), file.includes(KEY), file.includes(PASSWORD)], [false, false, false])
})

test('two wallets are encrypted with different IVs', async () => {
  const store = fastStore()
  const a = await addAccount(store, 'a', SEED, PASSWORD)
  const b = await addAccount(store, 'b', KEY, PASSWORD)
  assert.notEqual(a.iv, b.iv)
})

test('a wallet made for a stop-over chain is marked as a transit wallet', async () => {
  const record = await addAccount(fastStore(), 'transit-arb-1', KEY, PASSWORD, { chainKey: 'arb', createdAt: '2026-11-26T00:00:00.000Z' })
  assert.deepEqual(record.transit, { chainKey: 'arb', createdAt: '2026-11-26T00:00:00.000Z' })
})

test('an ordinary wallet carries no transit mark', async () => {
  assert.equal('transit' in (await addAccount(fastStore(), 'main', SEED, PASSWORD)), false)
})

// ---- finding and unlocking ----

const keystoreWith = (...names: string[]): Keystore => ({ version: 1, salt: '0x00', iterations: 1, accounts: names.map((name) => ({ name, type: 'key', addresses: { evm: '0x0' }, iv: '0x00', data: '0x00' })) })

test('without a name, the first wallet is used', () => {
  assert.equal(findAccount(keystoreWith('first', 'second')).name, 'first')
})

test('a named wallet is found by its name', () => {
  assert.equal(findAccount(keystoreWith('first', 'second'), 'second').name, 'second')
})

test('a name no wallet has is reported', () => {
  assert.throws(() => findAccount(keystoreWith('first'), 'third'), /^Error: No wallet named "third"$/)
})

test('an empty keystore says how to make a wallet', () => {
  assert.throws(() => findAccount(keystoreWith()), /^Error: No wallet yet\. Create one with "chainer wallet init" or "chainer wallet import"\.$/)
})

test('unlocking with the right password gives the wallet’s own signer', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  assert.equal((await unlock(store, 'main', PASSWORD)).evm.address, SEED_EVM)
})

test('unlocking a seed wallet also gives the seed for the other chain families', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  assert.equal((await unlock(store, 'main', PASSWORD)).seed?.length, 64)
})

test('unlocking a key wallet gives no seed', async () => {
  const store = fastStore()
  await addAccount(store, 'key', KEY, PASSWORD)
  assert.equal((await unlock(store, 'key', PASSWORD)).seed, undefined)
})

test('unlocking with a wrong password is refused', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  await assert.rejects(unlock(store, 'main', 'correct horsE'), /^Error: Wrong password$/)
})

test('unlocking a wallet whose stored data was tampered with is refused, not decrypted to garbage', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  const ks = JSON.parse(store.raw()) as Keystore
  const flipped = ks.accounts[0]!.data.slice(0, -2) + (ks.accounts[0]!.data.endsWith('00') ? '01' : '00')
  await store.set('keystore.json', JSON.stringify({ ...ks, accounts: [{ ...ks.accounts[0]!, data: flipped }] }))
  await assert.rejects(unlock(store, 'main', PASSWORD), /^Error: Wrong password$/)
})

test('a damaged keystore file is reported as such, with a warning not to delete it', async () => {
  const store = fastStore()
  await store.set('keystore.json', '{"version":1,"accounts":[')
  await assert.rejects(loadKeystore(store), /^Error: The wallet file \(keystore\.json\) is damaged and could not be read: .*Do not delete it/)
})

// ---- refreshing old wallets ----

test('refreshing an old wallet that only knew its EVM address adds the other chains', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  const ks = JSON.parse(store.raw()) as Keystore
  await store.set('keystore.json', JSON.stringify({ ...ks, accounts: [{ ...ks.accounts[0]!, addresses: { evm: SEED_EVM } }] }))
  const record = await refreshAddresses(store, 'main', PASSWORD)
  assert.deepEqual([record.addresses.evm, typeof record.addresses.sol], [SEED_EVM, 'string'])
})

test('refreshing is saved, so the next load has the new addresses', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  const ks = JSON.parse(store.raw()) as Keystore
  await store.set('keystore.json', JSON.stringify({ ...ks, accounts: [{ ...ks.accounts[0]!, addresses: { evm: SEED_EVM } }] }))
  await refreshAddresses(store, 'main', PASSWORD)
  assert.equal(typeof (await loadKeystore(store)).accounts[0]!.addresses.btc, 'string')
})

test('refreshing with a wrong password changes nothing', async () => {
  const store = fastStore()
  await addAccount(store, 'main', SEED, PASSWORD)
  const before = store.raw()
  await assert.rejects(refreshAddresses(store, 'main', 'wrong password'), /^Error: Wrong password$/)
  assert.equal(store.raw(), before)
})
