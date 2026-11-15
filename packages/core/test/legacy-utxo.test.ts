import assert from 'node:assert/strict'
import { test } from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { mnemonicToSeedSync } from '@scure/bip39'
import * as btc from '@scure/btc-signer'
import { mnemonicToAccount } from 'viem/accounts'
import {
  addressCodec,
  bitcoinAdapter,
  BUILTIN_CHAINS,
  cashAddrDecode,
  chainAddress,
  hash160,
  isNative,
  lifiToken,
  lifiTokens,
  outputScript,
  sighash,
  signLegacyTx,
  UTXO_COINS,
  utxoKey,
  type Signer,
} from '../src/index.ts'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const seed = mnemonicToSeedSync(MNEMONIC)
const signer: Signer = { evm: mnemonicToAccount(MNEMONIC), seed }
const chainOf = (key: string) => BUILTIN_CHAINS.find((c) => c.key === key)!

test('CashAddr matches the specification vector', () => {
  const legacy = addressCodec({ ...UTXO_COINS.bch!, cashAddrPrefix: undefined })
  const cash = addressCodec(UTXO_COINS.bch!)
  const decoded = cash.decode('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')
  assert.equal(decoded.type, 'p2pkh')
  assert.equal(legacy.encode(decoded.hash), '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu')
  assert.equal(cash.encode(decoded.hash), 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')
  // Without prefix, in the old Base58 form and in upper case all name the same address.
  assert.deepEqual(cash.decode('qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a').hash, decoded.hash)
  assert.deepEqual(cash.decode('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu').hash, decoded.hash)
  assert.deepEqual(cashAddrDecode('bitcoincash', 'BITCOINCASH:QPM2QSZNHKS23Z7629MMS6S4CWEF74VCWVY22GDX6A').hash, decoded.hash)
  assert.throws(() => cash.decode('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b'))
})

test('Pay-to-script-hash CashAddr from the specification decodes', () => {
  const d = cashAddrDecode('bitcoincash', 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq')
  assert.equal(d.type, 'p2sh')
  assert.equal(addressCodec(UTXO_COINS.bch!).encode(d.hash, 'p2sh'), 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq')
})

test('Addresses from the standard test seed use each coin\'s own format', () => {
  assert.match(chainAddress(signer, chainOf('doge')), /^D[1-9A-HJ-NP-Za-km-z]{33}$/)
  assert.match(chainAddress(signer, chainOf('dash')), /^X[1-9A-HJ-NP-Za-km-z]{33}$/)
  assert.match(chainAddress(signer, chainOf('bch')), /^bitcoincash:q[a-z0-9]{41}$/)
  assert.match(chainAddress(signer, chainOf('ltc')), /^ltc1q/)
})

test('the key of a legacy coin is the BIP-44 key of the seed', () => {
  // The same path as the well-known Bitcoin BIP-44 vector, with coin type 0, gives 1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA.
  const btcLegacy = { ...UTXO_COINS.btc!, legacy: true }
  const original = UTXO_COINS.btc
  UTXO_COINS.btc = btcLegacy
  try {
    assert.equal(utxoKey(seed, 'btc').address, '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA')
  } finally {
    UTXO_COINS.btc = original
  }
})

const key = utxoKey(seed, 'doge')
const dogeCodec = addressCodec(UTXO_COINS.doge!)
const ownScript = outputScript(dogeCodec.decode(key.address))
const toScript = outputScript(dogeCodec.decode(dogeCodec.encode(hash160(secp256k1.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1), true)))))
const inputs = [
  { txid: 'aa'.repeat(32), vout: 1, value: 700_000_000n, script: ownScript },
  { txid: 'bb'.repeat(32), vout: 0, value: 300_000_000n, script: ownScript },
]
const outputs = [
  { script: toScript, amount: 900_000_000n },
  { script: ownScript, amount: 99_000_000n },
]

const reference = () => {
  const tx = new btc.Transaction({ version: 1, allowLegacyWitnessUtxo: true, allowUnknownOutputs: true })
  for (const i of inputs) tx.addInput({ txid: i.txid, index: i.vout, sequence: 0xffffffff, witnessUtxo: { script: i.script, amount: i.value } })
  for (const o of outputs) tx.addOutput({ script: o.script, amount: o.amount })
  return tx
}

test('the legacy digest is the one @scure/btc-signer signs', () => {
  const tx = reference() as unknown as { preimageLegacy(i: number, script: Uint8Array, hashType: number): Uint8Array }
  for (const i of [0, 1]) assert.deepEqual(sighash(inputs, outputs, i, false), tx.preimageLegacy(i, ownScript, 1))
})

test('the legacy signatures verify and the transaction parses', () => {
  const raw = signLegacyTx({ inputs, outputs, privateKey: key.privateKey, publicKey: key.publicKey, forkId: false })
  const tx = btc.RawTx.decode(raw)
  assert.equal(tx.version, 1)
  assert.equal(tx.outputs.length, 2)
  for (const [i, input] of tx.inputs.entries()) {
    const script = btc.Script.decode(input.finalScriptSig!)
    const sig = script[0] as Uint8Array
    assert.equal(sig.at(-1), 1)
    assert.ok(secp256k1.verify(sig.slice(0, -1), sighash(inputs, outputs, i, false), key.publicKey, { prehash: false, format: 'der', lowS: true }))
  }
})

test('the fork-id digest is the BIP-143 digest with hash type 0x41', () => {
  const tx = reference()
  for (const i of [0, 1]) assert.deepEqual(sighash(inputs, outputs, i, true), tx.preimageWitnessV0(i, ownScript, 0x41, inputs[i]!.value))
})

test('a Bitcoin Cash signature verifies against its fork-id digest', () => {
  const raw = signLegacyTx({ inputs, outputs, privateKey: key.privateKey, publicKey: key.publicKey, forkId: true })
  const tx = btc.RawTx.decode(raw)
  assert.equal(tx.inputs.length, 2)
  for (const [i, input] of tx.inputs.entries()) {
    const script = btc.Script.decode(input.finalScriptSig!)
    const sig = script[0] as Uint8Array
    assert.equal(sig.at(-1), 0x41)
    assert.deepEqual(script[1], key.publicKey)
    assert.ok(secp256k1.verify(sig.slice(0, -1), sighash(inputs, outputs, i, true), key.publicKey, { prehash: false, format: 'der', lowS: true }))
  }
})

// ---- Adapters against fake nodes ------------------------------------------

function fakeNode(handlers: Record<string, (init?: RequestInit) => Response>) {
  const calls: { path: string; init?: RequestInit }[] = []
  const fetchFn: typeof fetch = async (url, init) => {
    const u = new URL(String(url))
    const path = u.pathname + u.search
    calls.push({ path, init })
    const h = Object.entries(handlers).find(([p]) => path.endsWith(p))
    return h ? h[1](init) : new Response('not found', { status: 404 })
  }
  return { calls, fetchFn }
}
const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })

function decodeBroadcast(rawHex: string) {
  const tx = btc.RawTx.decode(hex.decode(rawHex))
  return { inputs: tx.inputs, outputs: tx.outputs }
}

test('Dogecoin: BlockCypher balance, a deposit with memo, and the broadcast transaction', async () => {
  const me = chainAddress(signer, chainOf('doge'))
  const vault = dogeCodec.encode(hash160(secp256k1.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 9), true)))
  let pushed = ''
  const node = fakeNode({
    [`/addrs/${me}/balance`]: () => ok({ final_balance: 1_000_000_000 }),
    [`/addrs/${me}?unspentOnly=true&limit=200`]: () => ok({ txrefs: [{ tx_hash: 'cc'.repeat(32), tx_output_n: 0, value: 1_000_000_000, double_spend: false }] }),
    '/v1/doge/main': () => ok({ medium_fee_per_kb: 100_000_000 }),
    '/txs/push': (init) => {
      pushed = JSON.parse(String(init!.body)).tx
      return ok({ tx: { hash: 'dd'.repeat(32) } }, 201)
    },
  })
  const adapter = bitcoinAdapter(chainOf('doge'), { fetch: node.fetchFn })
  assert.deepEqual(await adapter.getBalances(me, [{ chainKey: 'doge', address: 'dogecoin', symbol: 'DOGE', decimals: 8 }]), [1_000_000_000n])
  const id = await adapter.send({ kind: 'utxo-send', chainKey: 'doge', to: vault, amount: 500_000_000n, memo: '=:ETH.ETH:0xabc:100' }, signer)
  assert.equal(id, 'dd'.repeat(32))
  const { outputs: outs } = decodeBroadcast(pushed)
  assert.equal(outs.length, 3)
  assert.equal(outs[0]!.amount, 500_000_000n)
  assert.deepEqual(outs[0]!.script, outputScript(dogeCodec.decode(vault)))
  assert.equal(outs[1]!.amount, 0n)
  assert.equal(new TextDecoder().decode((btc.Script.decode(outs[1]!.script)[1] as Uint8Array)), '=:ETH.ETH:0xabc:100')
  // 100 000 000 koinu per kB is 100 000 per byte; about 280 bytes cost about 0.28 DOGE.
  const change = outs[2]!.amount
  assert.ok(change > 400_000_000n && change < 500_000_000n - 20_000_000n, `change ${change}`)
  assert.deepEqual(outs[2]!.script, ownScript)
})

test('Dash: BlockCypher coins and broadcast, unconfirmed coins are not spent', async () => {
  const me = chainAddress(signer, chainOf('dash'))
  const dashCodec = addressCodec(UTXO_COINS.dash!)
  const vault = dashCodec.encode(hash160(secp256k1.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 5), true)))
  let pushed = ''
  const node = fakeNode({
    [`/addrs/${me}?unspentOnly=true&limit=200`]: () =>
      ok({
        unconfirmed_txrefs: [{ tx_hash: 'ee'.repeat(32), tx_output_n: 0, value: 900_000_000, double_spend: false }],
        txrefs: [{ tx_hash: 'ff'.repeat(32), tx_output_n: 2, value: 50_000_000, double_spend: false }],
      }),
    '/v1/dash/main': () => ok({ medium_fee_per_kb: 20_000 }),
    '/txs/push': (init) => {
      pushed = JSON.parse(String(init!.body)).tx
      return ok({ tx: { hash: '11'.repeat(32) } }, 201)
    },
  })
  const adapter = bitcoinAdapter(chainOf('dash'), { fetch: node.fetchFn })
  await assert.rejects(adapter.send({ kind: 'utxo-send', chainKey: 'dash', to: vault, amount: 100_000_000n }, signer), /Not enough DASH/)
  assert.equal(await adapter.send({ kind: 'utxo-send', chainKey: 'dash', to: vault, amount: 20_000_000n }, signer), '11'.repeat(32))
  const { inputs: ins, outputs: outs } = decodeBroadcast(pushed)
  assert.equal(ins.length, 1)
  assert.equal(hex.encode(ins[0]!.txid), 'ff'.repeat(32))
  assert.equal(outs[0]!.amount, 20_000_000n)
})

test('Bitcoin Cash: REST coins, CashAddr recipient and a fork-id signed broadcast', async () => {
  const me = chainAddress(signer, chainOf('bch'))
  const bchCodec = addressCodec(UTXO_COINS.bch!)
  const vault = bchCodec.encode(hash160(secp256k1.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 3), true))).replace('bitcoincash:', '')
  let pushed = ''
  const node = fakeNode({
    [`/address/utxo/${me}`]: () => ok({ utxos: [{ txid: '22'.repeat(32), vout: 1, satoshis: 10_000_000, confirmations: 3 }] }),
    [`/address/details/${me}`]: () => ok({ balanceSat: 10_000_000, unconfirmedBalanceSat: 500 }),
    '/rawtransactions/sendRawTransaction': () => ok(''),
  })
  const fetchFn: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    const m = path.match(/\/rawtransactions\/sendRawTransaction\/([0-9a-f]+)$/)
    if (m) {
      pushed = m[1]!
      return ok('33'.repeat(32))
    }
    return node.fetchFn(url, init)
  }
  const adapter = bitcoinAdapter(chainOf('bch'), { fetch: fetchFn })
  assert.equal(adapter.validateAddress(vault), true)
  assert.equal(adapter.validateAddress('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b'), false)
  assert.deepEqual(await adapter.getBalances(me, [{ chainKey: 'bch', address: 'bitcoincash', symbol: 'BCH', decimals: 8 }]), [10_000_500n])
  assert.equal(await adapter.send({ kind: 'utxo-send', chainKey: 'bch', to: vault, amount: 4_000_000n }, signer), '33'.repeat(32))

  const raw = hex.decode(pushed)
  const tx = btc.RawTx.decode(raw)
  const sentInputs = [{ txid: '22'.repeat(32), vout: 1, value: 10_000_000n, script: outputScript(bchCodec.decode(me)) }]
  const sentOutputs = tx.outputs.map((o) => ({ script: o.script, amount: o.amount }))
  const script = btc.Script.decode(tx.inputs[0]!.finalScriptSig!)
  const sig = script[0] as Uint8Array
  assert.equal(sig.at(-1), 0x41)
  assert.ok(secp256k1.verify(sig.slice(0, -1), sighash(sentInputs, sentOutputs, 0, true), script[1] as Uint8Array, { prehash: false, format: 'der', lowS: true }))
  assert.equal(sentOutputs[0]!.amount, 4_000_000n)
})

test('a fee out of proportion refuses to send', async () => {
  const me = chainAddress(signer, chainOf('doge'))
  const node = fakeNode({
    [`/addrs/${me}?unspentOnly=true&limit=200`]: () => ok({ txrefs: [{ tx_hash: 'cc'.repeat(32), tx_output_n: 0, value: 100_000_000_000, double_spend: false }] }),
    '/v1/doge/main': () => ok({ medium_fee_per_kb: 50_000_000_000 }),
  })
  const adapter = bitcoinAdapter(chainOf('doge'), { fetch: node.fetchFn })
  const vault = dogeCodec.encode(hash160(secp256k1.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 9), true)))
  await assert.rejects(adapter.send({ kind: 'utxo-send', chainKey: 'doge', to: vault, amount: 100_000_000n }, signer), /too high/)
})

test('a PSBT is refused for a legacy coin', async () => {
  const adapter = bitcoinAdapter(chainOf('doge'), { fetch: fakeNode({}).fetchFn })
  await assert.rejects(adapter.send({ kind: 'utxo-psbt', chainKey: 'doge', psbt: '00', to: 'x', amount: 1n }, signer), /cannot sign a PSBT/)
})

test('chains LI.FI does not list only have their own coin, resolved without asking LI.FI', async () => {
  const never: typeof fetch = async () => {
    throw new Error('LI.FI must not be asked')
  }
  const doge = await lifiToken(never, chainOf('doge'), 'doge')
  assert.deepEqual(doge, { chainKey: 'doge', address: 'dogecoin', symbol: 'DOGE', decimals: 8 })
  assert.equal(isNative(doge), true)
  assert.deepEqual(await lifiTokens(never, chainOf('bch')), [{ chainKey: 'bch', address: 'bitcoincash', symbol: 'BCH', decimals: 8 }])
  await assert.rejects(lifiToken(never, chainOf('dash'), 'USDC'), /only has its own coin/)
})
