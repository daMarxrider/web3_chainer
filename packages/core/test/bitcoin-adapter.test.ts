import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base64, hex } from '@scure/base'
import { mnemonicToSeedSync } from '@scure/bip39'
import * as btc from '@scure/btc-signer'
import { mnemonicToAccount } from 'viem/accounts'
import { BUILTIN_CHAINS, bitcoinAdapter, chainAddress, UTXO_COINS, utxoKey, type Chain, type Signer } from '../src/index.ts'

// ---- fixtures ----

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const seed = mnemonicToSeedSync(MNEMONIC)
const signer: Signer = { evm: mnemonicToAccount(MNEMONIC), seed }
const keyOnly: Signer = { evm: mnemonicToAccount(MNEMONIC) }
const testnet4 = BUILTIN_CHAINS.find((c) => c.key === 'btct')!
const twoNodes: Chain = { ...testnet4, rpcUrls: ['https://first.node/api', 'https://second.node/api'] }
const net = UTXO_COINS.btct!.network
const me = chainAddress(signer, testnet4)
const THEM = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const FUNDING_TXID = 'aa'.repeat(32)

type Answer = Response | 'network-error'
/**
 * An Esplora node at the fetch boundary. By default it holds one 100 000-sat coin for the wallet and
 * estimates 2 sat/vB; `routes` overrides answers by "host path".
 */
function esplora(opts: { utxos?: { txid: string; vout: number; value: number }[]; fees?: Record<string, number>; routes?: Record<string, () => Answer>; refuse?: string } = {}) {
  const broadcasts: string[] = []
  const asked: string[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const path = u.pathname.replace(/^\/(testnet4\/)?api/, '')
    asked.push(`${u.host} ${path}`)
    const override = opts.routes?.[`${u.host} ${path}`] ?? opts.routes?.[path]
    if (override) {
      const a = override()
      if (a === 'network-error') throw new TypeError('fetch failed')
      return a
    }
    const json = (v: unknown) => new Response(JSON.stringify(v))
    if (path === '/fee-estimates') return json(opts.fees ?? { '3': 2 })
    if (path === `/address/${me}/utxo`) return json(opts.utxos ?? [{ txid: FUNDING_TXID, vout: 0, value: 100_000 }])
    if (path === '/tx' && init?.method === 'POST') {
      if (opts.refuse) return new Response(opts.refuse, { status: 400 })
      broadcasts.push(String(init.body))
      return new Response('broadcast-txid\n')
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  /** The broadcast transaction's outputs and the fee it pays (inputs are the 100 000-sat coin). */
  const sent = (i = 0, inputs = 100_000n) => {
    const tx = btc.Transaction.fromRaw(hex.decode(broadcasts[i]!), { allowUnknownOutputs: true })
    const outs = Array.from({ length: tx.outputsLength }, (_, n) => tx.getOutput(n))
    return { outs, fee: inputs - outs.reduce((s, o) => s + o.amount!, 0n), inputs: tx.inputsLength }
  }
  return { fetchFn, broadcasts, asked, sent }
}
const send = (node: ReturnType<typeof esplora>, amount: bigint, extra: { memo?: string; to?: string } = {}, chain: Chain = testnet4, who: Signer = signer) =>
  bitcoinAdapter(chain, { fetch: node.fetchFn }).send({ kind: 'utxo-send', chainKey: 'btct', to: extra.to ?? THEM, amount, memo: extra.memo }, who)

// ---- setup ----

test('a chain that is not a Bitcoin-family chain the app knows is refused', () => {
  assert.throws(() => bitcoinAdapter({ ...testnet4, key: 'xyz', name: 'Nowhere' }, { fetch: esplora().fetchFn }), /^Error: Nowhere is not a supported Bitcoin-family chain$/)
})

test('without endpoints of its own, the chain uses the coin’s default node', async () => {
  const node = esplora({ routes: { [`/address/${me}`]: () => new Response(JSON.stringify({ chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } })) } })
  await bitcoinAdapter({ ...testnet4, rpcUrls: [] }, { fetch: node.fetchFn }).getBalances(me, [])
  assert.equal(node.asked[0], `mempool.space /address/${me}`)
})

// ---- endpoints ----

const stats = (confirmed: number) => () => new Response(JSON.stringify({ chain_stats: { funded_txo_sum: confirmed, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } }))

test('a node that rate-limits is skipped for the next one', async () => {
  const node = esplora({ routes: { [`first.node /address/${me}`]: () => new Response('slow down', { status: 429 }), [`second.node /address/${me}`]: stats(7) } })
  assert.deepEqual(await bitcoinAdapter(twoNodes, { fetch: node.fetchFn }).getBalances(me, [{ chainKey: 'btct', address: 'bitcoin', symbol: 'tBTC', decimals: 8 }]), [7n])
})

test('a node with a server error is skipped for the next one', async () => {
  const node = esplora({ routes: { [`first.node /address/${me}`]: () => new Response('oops', { status: 502 }), [`second.node /address/${me}`]: stats(7) } })
  assert.deepEqual(await bitcoinAdapter(twoNodes, { fetch: node.fetchFn }).getBalances(me, [{ chainKey: 'btct', address: 'bitcoin', symbol: 'tBTC', decimals: 8 }]), [7n])
})

test('a node that cannot be reached is skipped for the next one', async () => {
  const node = esplora({ routes: { [`first.node /address/${me}`]: () => 'network-error', [`second.node /address/${me}`]: stats(7) } })
  assert.deepEqual(await bitcoinAdapter(twoNodes, { fetch: node.fetchFn }).getBalances(me, [{ chainKey: 'btct', address: 'bitcoin', symbol: 'tBTC', decimals: 8 }]), [7n])
})

test('a node answering 404 is final and names the chain and the path', async () => {
  const node = esplora({ routes: { [`first.node /address/${me}`]: () => new Response('Invalid Bitcoin address', { status: 404 }) } })
  await assert.rejects(bitcoinAdapter(twoNodes, { fetch: node.fetchFn }).getBalances(me, []), new RegExp(`^Error: Bitcoin Testnet4 node responded 404 for /address/${me}: Invalid Bitcoin address$`))
})

test('when every node fails, the last failure is reported', async () => {
  const node = esplora({ routes: { [`/address/${me}`]: () => new Response('down', { status: 503 }) } })
  await assert.rejects(bitcoinAdapter(twoNodes, { fetch: node.fetchFn }).getBalances(me, []), /^Error: second\.node responded 503$/)
})

// ---- balances ----

test('coins already spent in the mempool are taken off the balance', async () => {
  const node = esplora({ routes: { [`/address/${me}`]: () => new Response(JSON.stringify({ chain_stats: { funded_txo_sum: 100_000, spent_txo_sum: 20_000 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 30_000 } })) } })
  // 100 000 - 20 000 confirmed, minus 30 000 being spent = 50 000
  assert.deepEqual(await bitcoinAdapter(testnet4, { fetch: node.fetchFn }).getBalances(me, [{ chainKey: 'btct', address: 'bitcoin', symbol: 'tBTC', decimals: 8 }]), [50_000n])
})

// ---- fee rates ----

test('the fee rate for about three blocks is used, rounded up to whole sats', async () => {
  // 1 input, 2 outputs: 11 + 68 + 31 + 31 = 141 vbytes; 2.3 sat/vB rounds up to 3 -> 423 sats.
  const node = esplora({ fees: { '3': 2.3, '6': 1 } })
  await send(node, 10_000n)
  assert.equal(node.sent().fee, 423n)
})

test('without a three-block estimate the six-block one is used', async () => {
  const node = esplora({ fees: { '6': 4 } })
  await send(node, 10_000n)
  assert.equal(node.sent().fee, 564n) // 141 x 4
})

test('without any estimate 2 sat/vB is used', async () => {
  const node = esplora({ fees: {} })
  await send(node, 10_000n)
  assert.equal(node.sent().fee, 282n) // 141 x 2
})

test('the fee rate is never below 1 sat/vB', async () => {
  const node = esplora({ fees: { '3': 0.2 } })
  await send(node, 10_000n)
  assert.equal(node.sent().fee, 141n)
})

// ---- plain sends ----

test('change smaller than dust is left to the miners instead of becoming an output', async () => {
  // 100 000 - 99 218 - 282 fee = 500 sats of change, under the 546-sat dust limit.
  const node = esplora()
  await send(node, 99_218n)
  assert.deepEqual([node.sent().outs.length, node.sent().fee], [1, 782n])
})

test('change of exactly the dust limit is kept', async () => {
  // 100 000 - 99 172 - 282 = 546
  const node = esplora()
  await send(node, 99_172n)
  assert.deepEqual(node.sent().outs.map((o) => o.amount), [99_172n, 546n])
})

test('the largest coins are spent first and only as many as needed', async () => {
  const node = esplora({ utxos: [{ txid: 'bb'.repeat(32), vout: 0, value: 5_000 }, { txid: FUNDING_TXID, vout: 1, value: 80_000 }, { txid: 'cc'.repeat(32), vout: 2, value: 30_000 }] })
  await send(node, 50_000n)
  assert.equal(node.sent(0, 80_000n).inputs, 1)
})

test('coins are added until they cover the amount and the larger fee of more inputs', async () => {
  // Two inputs: 11 + 136 + 62 = 209 vbytes x 2 = 418 sats; 60 000 + 30 000 covers 70 000 + 418.
  const node = esplora({ utxos: [{ txid: 'bb'.repeat(32), vout: 0, value: 60_000 }, { txid: 'cc'.repeat(32), vout: 1, value: 30_000 }] })
  await send(node, 70_000n)
  assert.deepEqual([node.sent(0, 90_000n).inputs, node.sent(0, 90_000n).fee], [2, 418n])
})

test('the error for too little money says how much is needed with the fee', async () => {
  // 100 000 + 282 fee needed, 100 000 held.
  await assert.rejects(send(esplora(), 100_000n), /^Error: Not enough tBTC: need 100282 sats including the fee, the wallet holds 100000$/)
})

test('a wallet without coins is told the need with the fee of at least one input', async () => {
  // 10 000 + 141 vbytes x 2 sat/vB = 10 282
  await assert.rejects(send(esplora({ utxos: [] }), 10_000n), /^Error: Not enough tBTC: need 10282 sats including the fee, the wallet holds 0$/)
})

test('a fee above 5 % of the amount plus 5 000 sats is refused', async () => {
  // Cap for 1 000 sats: 50 + 5 000 = 5 050; 141 x 40 sat/vB = 5 640.
  await assert.rejects(send(esplora({ fees: { '3': 40 } }), 1_000n), /^Error: The network fee of 5640 sats is too high for this amount right now$/)
})

test('a fee just under the cap is accepted', async () => {
  const node = esplora({ fees: { '3': 35 } }) // 141 x 35 = 4 935 <= 5 050
  await send(node, 1_000n)
  assert.equal(node.sent().fee, 4_935n)
})

test('a memo of 80 bytes fits', async () => {
  const node = esplora()
  await send(node, 10_000n, { memo: 'm'.repeat(80) })
  assert.equal(node.broadcasts.length, 1)
})

test('a memo of 81 bytes is refused before anything is fetched', async () => {
  const node = esplora()
  await assert.rejects(send(node, 10_000n, { memo: 'm'.repeat(81) }), /^Error: A memo longer than 80 bytes does not fit in a standard transaction$/)
  assert.deepEqual(node.asked, [])
})

test('a memo makes the fee grow by its size', async () => {
  // 141 + 10-byte memo + 11 = 162 vbytes x 2 = 324 sats.
  const node = esplora()
  await send(node, 10_000n, { memo: '0123456789' })
  assert.equal(node.sent().fee, 324n)
})

test('a wallet made from an EVM private key cannot send bitcoin', async () => {
  await assert.rejects(send(esplora(), 10_000n, {}, testnet4, keyOnly), /^Error: This wallet has no Bitcoin Testnet4 key: it was made from a single EVM private key$/)
})

test('an action for another chain family is refused by name', async () => {
  await assert.rejects(bitcoinAdapter(testnet4, { fetch: esplora().fetchFn }).send({ kind: 'evm-tx', chainKey: 'eth', to: '0x0', data: '0x', value: 0n }, signer), /^Error: Bitcoin Testnet4 cannot run a "evm-tx" action$/)
})

test('a transaction the node refuses is reported with the node’s reason', async () => {
  await assert.rejects(send(esplora({ refuse: 'min relay fee not met' }), 10_000n), /^Error: The Bitcoin Testnet4 node refused the transaction: min relay fee not met$/)
})

test('the broadcast returns the node’s transaction id without surrounding space', async () => {
  assert.equal(await send(esplora(), 10_000n), 'broadcast-txid')
})

test('there is nothing to prepare before a Bitcoin transaction', async () => {
  const node = esplora()
  await bitcoinAdapter(testnet4, { fetch: node.fetchFn }).prepare({ kind: 'utxo-send', chainKey: 'btct', to: THEM, amount: 1n }, signer, () => {})
  assert.deepEqual(node.asked, [])
})

// ---- prepared transactions (PSBTs from route sources) ----

const ownScript = () => btc.OutScript.encode(btc.Address(net).decode(utxoKey(seed, 'btct').address))
/** A PSBT spending one input, by default the wallet's 100 000-sat coin, paying the given outputs. */
function psbt(outputs: ({ to: string; amount: bigint } | { data: Uint8Array; amount: bigint })[], input: { amount?: bigint; script?: Uint8Array; noAmount?: boolean } = {}) {
  const tx = new btc.Transaction({ allowUnknownOutputs: true })
  tx.addInput({ txid: FUNDING_TXID, index: 0, ...(input.noAmount ? {} : { witnessUtxo: { script: input.script ?? ownScript(), amount: input.amount ?? 100_000n } }) })
  for (const o of outputs) {
    if ('to' in o) tx.addOutputAddress(o.to, o.amount, net)
    else tx.addOutput({ script: btc.Script.encode(['RETURN', o.data]), amount: o.amount })
  }
  return tx.toPSBT()
}
const sendPsbt = (node: ReturnType<typeof esplora>, raw: Uint8Array, encode: (b: Uint8Array) => string = hex.encode) =>
  bitcoinAdapter(testnet4, { fetch: node.fetchFn }).send({ kind: 'utxo-psbt', chainKey: 'btct', psbt: encode(raw), to: THEM, amount: 30_000n }, signer)

test('a PSBT sent as base64 is signed like one sent as hex', async () => {
  const node = esplora()
  await sendPsbt(node, psbt([{ to: THEM, amount: 30_000n }, { to: me, amount: 69_000n }]), base64.encode)
  assert.equal(node.broadcasts.length, 1)
})

test('a PSBT with a data output that carries no coins is signed', async () => {
  const node = esplora()
  await sendPsbt(node, psbt([{ to: THEM, amount: 30_000n }, { data: new Uint8Array([1, 2, 3]), amount: 0n }, { to: me, amount: 69_000n }]))
  assert.equal(node.broadcasts.length, 1)
})

test('a PSBT whose data output carries coins is refused', async () => {
  const node = esplora()
  await assert.rejects(sendPsbt(node, psbt([{ to: THEM, amount: 30_000n }, { data: new Uint8Array([1]), amount: 1_000n }, { to: me, amount: 68_000n }])), /^Error: A data output carries coins; refusing to sign$/)
  assert.equal(node.broadcasts.length, 0)
})

test('a PSBT whose input does not say how much it holds is refused', async () => {
  const node = esplora()
  await assert.rejects(sendPsbt(node, psbt([{ to: THEM, amount: 30_000n }], { noAmount: true })), /^Error: An input does not say how much it holds; refusing to sign$/)
})

test('a PSBT paying out more than its inputs hold is refused', async () => {
  const node = esplora()
  await assert.rejects(sendPsbt(node, psbt([{ to: THEM, amount: 30_000n }, { to: me, amount: 80_000n }])), /^Error: The transaction fee of -10000 is out of range; refusing to sign$/)
})

test('a PSBT fee of exactly 5 % of the amount plus 5 000 sats is accepted', async () => {
  // 30 000 x 5 % + 5 000 = 6 500 sats of fee: 100 000 - 30 000 - 63 500.
  const node = esplora()
  await sendPsbt(node, psbt([{ to: THEM, amount: 30_000n }, { to: me, amount: 63_500n }]))
  assert.equal(node.broadcasts.length, 1)
})

test('a PSBT fee one sat above the cap is refused', async () => {
  const node = esplora()
  await assert.rejects(sendPsbt(node, psbt([{ to: THEM, amount: 30_000n }, { to: me, amount: 63_499n }])), /^Error: The transaction fee of 6501 is out of range; refusing to sign$/)
})

test('a PSBT none of whose inputs belong to the wallet is refused', async () => {
  const strangerScript = btc.OutScript.encode(btc.Address(net).decode(THEM))
  const node = esplora()
  await assert.rejects(sendPsbt(node, psbt([{ to: THEM, amount: 30_000n }, { to: me, amount: 69_000n }], { script: strangerScript })), /^Error: No input of this transaction belongs to the wallet; refusing to sign$/)
  assert.equal(node.broadcasts.length, 0)
})

// ---- confirmation ----

const settle = () => new Promise<void>((r) => setImmediate(r))
/** Lets the given number of 30-second waits pass on the mocked clock. */
async function passWaits(timers: { tick: (ms: number) => void }, waits: number) {
  for (let i = 0; i < waits; i++) {
    await settle()
    timers.tick(30_000)
  }
}

test('a confirmed transaction counts as confirmed at once', async () => {
  const node = esplora({ routes: { '/tx/abc/status': () => new Response('{"confirmed":true}') } })
  assert.equal(await bitcoinAdapter(testnet4, { fetch: node.fetchFn }).waitForConfirmation('abc'), true)
})

test('an unconfirmed transaction is checked again every 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let checks = 0
  const node = esplora({ routes: { '/tx/abc/status': () => new Response(JSON.stringify({ confirmed: ++checks >= 3 })) } })
  const done = bitcoinAdapter(testnet4, { fetch: node.fetchFn }).waitForConfirmation('abc')
  await passWaits(t.mock.timers, 2)
  assert.deepEqual([await done, checks], [true, 3])
})

test('a transaction the node does not know yet is waited for, not failed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let checks = 0
  const node = esplora({ routes: { '/tx/abc/status': () => (++checks === 1 ? new Response('Transaction not found', { status: 404 }) : new Response('{"confirmed":true}')) } })
  const done = bitcoinAdapter(testnet4, { fetch: node.fetchFn }).waitForConfirmation('abc')
  await passWaits(t.mock.timers, 1)
  assert.equal(await done, true)
})

test('a transaction still unconfirmed after 6 hours is reported with advice to check', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const node = esplora({ routes: { '/tx/abc/status': () => new Response('{"confirmed":false}') } })
  const done = bitcoinAdapter(testnet4, { fetch: node.fetchFn }).waitForConfirmation('abc')
  await passWaits(t.mock.timers, 720)
  await assert.rejects(done, /^Error: Transaction abc is still unconfirmed after 6 hours\. Check an explorer; it may have been dropped\.$/)
})
