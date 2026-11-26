import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hex } from '@scure/base'
import { mnemonicToSeedSync } from '@scure/bip39'
import * as btc from '@scure/btc-signer'
import { mnemonicToAccount } from 'viem/accounts'
import { BUILTIN_CHAINS, bitcoinAdapter, chainAddress, legacyUtxoAdapter, UTXO_COINS, type Chain, type Signer } from '../src/index.ts'

// ---- fixtures ----

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const signer: Signer = { evm: mnemonicToAccount(MNEMONIC), seed: mnemonicToSeedSync(MNEMONIC) }
const keyOnly: Signer = { evm: mnemonicToAccount(MNEMONIC) }
const doge = BUILTIN_CHAINS.find((c) => c.key === 'doge')!
const bch = BUILTIN_CHAINS.find((c) => c.key === 'bch')!
const dogeTwoNodes: Chain = { ...doge, rpcUrls: ['https://first.node/v1/doge/main', 'https://second.node/v1/doge/main'] }
const myDoge = chainAddress(signer, doge)
const myBch = chainAddress(signer, bch)
const COIN = 'aa'.repeat(32)

type Handler = (init?: RequestInit) => Response | 'network-error'
/** A node at the fetch boundary: the first handler whose key the "host path" ends with answers. */
function nodeAt(handlers: Record<string, Handler>) {
  const asked: string[] = []
  const pushed: string[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const where = `${u.host}${u.pathname}${u.search}`
    asked.push(where)
    if (init?.method === 'POST') pushed.push(JSON.parse(String(init.body)).tx)
    const h = Object.entries(handlers).find(([k]) => where.endsWith(k))
    const r = h ? h[1](init) : new Response('not found', { status: 404 })
    if (r === 'network-error') throw new TypeError('fetch failed')
    return r
  }) as typeof fetch
  return { fetchFn, asked, pushed }
}
const ok = (v: unknown) => () => new Response(JSON.stringify(v))
/** A BlockCypher Dogecoin node holding one 100 DOGE coin (10^10 koinu) for the wallet. */
const dogeNode = (extra: Record<string, Handler> = {}, coins: unknown[] = [{ tx_hash: COIN, tx_output_n: 0, value: 10_000_000_000, double_spend: false }], fee: unknown = {}) =>
  nodeAt({
    [`/addrs/${myDoge}?unspentOnly=true&limit=200`]: ok({ txrefs: coins }),
    '/txs/push': ok({ tx: { hash: 'pushed-hash' } }),
    '/v1/doge/main': ok(fee),
    ...extra, // a test's own answer for a path replaces the default
  })
const sendDoge = (n: ReturnType<typeof nodeAt>, amount: bigint, extra: { memo?: string } = {}, who: Signer = signer) =>
  legacyUtxoAdapter(doge, UTXO_COINS.doge!, { fetch: n.fetchFn, blockcypher: true }).send({ kind: 'utxo-send', chainKey: 'doge', to: myDoge, amount, memo: extra.memo }, who)
/** Outputs and fee of the pushed transaction, given what its inputs held. */
const pushed = (n: ReturnType<typeof nodeAt>, inputs = 10_000_000_000n) => {
  const tx = btc.RawTx.decode(hex.decode(n.pushed[0]!))
  return { outs: tx.outputs.map((o) => o.amount), fee: inputs - tx.outputs.reduce((s, o) => s + o.amount, 0n), inputs: tx.inputs.length }
}

// ---- setup ----

test('a coin with no data source is refused by name', () => {
  assert.throws(() => legacyUtxoAdapter(doge, { ...UTXO_COINS.doge!, backend: 'nowhere' as never }, { fetch: nodeAt({}).fetchFn }), /^Error: Dogecoin has no data source$/)
})

test('Dogecoin is reached through the Bitcoin-family adapter too', async () => {
  const n = nodeAt({ [`/addrs/${myDoge}/balance`]: ok({ final_balance: 5 }) })
  assert.deepEqual(await bitcoinAdapter(doge, { fetch: n.fetchFn, blockcypher: true }).getBalances(myDoge, [{ chainKey: 'doge', address: 'dogecoin', symbol: 'DOGE', decimals: 8 }]), [5n])
})

// ---- endpoints ----

test('a node that rate-limits is skipped for the next one', async () => {
  const n = nodeAt({ [`first.node/v1/doge/main/addrs/${myDoge}/balance`]: () => new Response('slow', { status: 429 }), [`second.node/v1/doge/main/addrs/${myDoge}/balance`]: ok({ final_balance: 9 }) })
  assert.deepEqual(await legacyUtxoAdapter(dogeTwoNodes, UTXO_COINS.doge!, { fetch: n.fetchFn, blockcypher: true }).getBalances(myDoge, [{ chainKey: 'doge', address: 'dogecoin', symbol: 'DOGE', decimals: 8 }]), [9n])
})

test('a node that cannot be reached is skipped for the next one', async () => {
  const n = nodeAt({ [`first.node/v1/doge/main/addrs/${myDoge}/balance`]: () => 'network-error', [`second.node/v1/doge/main/addrs/${myDoge}/balance`]: ok({ final_balance: 9 }) })
  assert.deepEqual(await legacyUtxoAdapter(dogeTwoNodes, UTXO_COINS.doge!, { fetch: n.fetchFn, blockcypher: true }).getBalances(myDoge, [{ chainKey: 'doge', address: 'dogecoin', symbol: 'DOGE', decimals: 8 }]), [9n])
})

test('when every node fails, the last failure is reported', async () => {
  const n = nodeAt({ [`/addrs/${myDoge}/balance`]: () => new Response('down', { status: 500 }) })
  await assert.rejects(legacyUtxoAdapter(dogeTwoNodes, UTXO_COINS.doge!, { fetch: n.fetchFn, blockcypher: true }).getBalances(myDoge, []), /^Error: second\.node responded 500$/)
})

test('a node’s refusal names the path without its query', async () => {
  const n = dogeNode({ [`/addrs/${myDoge}?unspentOnly=true&limit=200`]: () => new Response('Address invalid', { status: 400 }) })
  await assert.rejects(sendDoge(n, 100_000_000n), new RegExp(`^Error: The node responded 400 for /addrs/${myDoge}: Address invalid$`))
})

// ---- what may be sent ----

test('a prepared transaction from a route source is refused for a legacy coin, with what to use instead', async () => {
  const adapter = legacyUtxoAdapter(doge, UTXO_COINS.doge!, { fetch: dogeNode().fetchFn, blockcypher: true })
  await assert.rejects(adapter.send({ kind: 'utxo-psbt', chainKey: 'doge', psbt: '00', to: myDoge, amount: 1n }, signer), /^Error: Dogecoin cannot sign a PSBT from a route source; use a route that deposits to an address \(THORChain, Maya\)$/)
})

test('an action for another chain family is refused by name', async () => {
  const adapter = legacyUtxoAdapter(doge, UTXO_COINS.doge!, { fetch: dogeNode().fetchFn, blockcypher: true })
  await assert.rejects(adapter.send({ kind: 'evm-tx', chainKey: 'eth', to: '0x0', data: '0x', value: 0n }, signer), /^Error: Dogecoin cannot run a "evm-tx" action$/)
})

test('a wallet made from an EVM private key cannot send Dogecoin', async () => {
  await assert.rejects(sendDoge(dogeNode(), 100_000_000n, {}, keyOnly), /^Error: This wallet has no Dogecoin key: it was made from a single EVM private key$/)
})

test('a memo of 81 bytes is refused before anything is fetched', async () => {
  const n = dogeNode()
  await assert.rejects(sendDoge(n, 100_000_000n, { memo: 'm'.repeat(81) }), /^Error: A memo longer than 80 bytes does not fit in a standard transaction$/)
  assert.deepEqual(n.asked, [])
})

// ---- fees and coins ----

test('without a fee estimate the coin’s minimum rate is used', async () => {
  // 226 bytes x 1 000 koinu per byte.
  const n = dogeNode()
  await sendDoge(n, 100_000_000n)
  assert.equal(pushed(n).fee, 226_000n)
})

test('an estimate below the coin’s minimum rate is raised to the minimum', async () => {
  // 500 000 per kB = 500 per byte, under Dogecoin's 1 000.
  const n = dogeNode({}, undefined, { medium_fee_per_kb: 500_000 })
  await sendDoge(n, 100_000_000n)
  assert.equal(pushed(n).fee, 226_000n)
})

test('an estimate above the minimum is used, per byte', async () => {
  // 2 000 000 per kB = 2 000 per byte x 226 bytes.
  const n = dogeNode({}, undefined, { medium_fee_per_kb: 2_000_000 })
  await sendDoge(n, 100_000_000n)
  assert.equal(pushed(n).fee, 452_000n)
})

test('a memo adds its size and 11 bytes to the fee', async () => {
  // 226 + 11 + 10 = 247 bytes x 1 000.
  const n = dogeNode()
  await sendDoge(n, 100_000_000n, { memo: '0123456789' })
  assert.equal(pushed(n).fee, 247_000n)
})

test('a coin flagged as a double spend is never used', async () => {
  const n = dogeNode({}, [{ tx_hash: COIN, tx_output_n: 0, value: 10_000_000_000, double_spend: true }])
  await assert.rejects(sendDoge(n, 100_000_000n), /^Error: Not enough DOGE: need 100226000 including the fee, the wallet holds 0 \(confirmed\)$/)
})

test('an address without coins has nothing to send', async () => {
  const n = dogeNode({ [`/addrs/${myDoge}?unspentOnly=true&limit=200`]: ok({}) })
  await assert.rejects(sendDoge(n, 100_000_000n), /the wallet holds 0 \(confirmed\)/)
})

test('change one koinu under Dogecoin’s 0.01 DOGE dust limit is left to the miners', async () => {
  // 10^10 - 9 989 774 001 - 226 000 fee = 9 999 999 koinu of change, under the 10 000 000 dust limit.
  const n = dogeNode()
  await sendDoge(n, 9_989_774_001n)
  assert.deepEqual(pushed(n).outs, [9_989_774_001n])
})

test('change of exactly the dust limit is kept', async () => {
  // 10^10 - 9 989 774 000 - 226 000 fee = 10 000 000 koinu, exactly the limit.
  const n = dogeNode()
  await sendDoge(n, 9_989_774_000n)
  assert.deepEqual(pushed(n).outs, [9_989_774_000n, 10_000_000n])
})

test('the broadcast returns BlockCypher’s transaction hash', async () => {
  assert.equal(await sendDoge(dogeNode(), 100_000_000n), 'pushed-hash')
})

test('a transaction BlockCypher refuses is reported with its reason', async () => {
  const n = dogeNode({ '/txs/push': () => new Response('{"error":"Transaction fee too low"}', { status: 400 }) })
  await assert.rejects(sendDoge(n, 100_000_000n), /^Error: The node refused the transaction: \{"error":"Transaction fee too low"\}$/)
})

// ---- Bitcoin Cash REST backend ----

const bchNode = (extra: Record<string, Handler> = {}) =>
  nodeAt({
    [`/address/utxo/${myBch}`]: ok({ utxos: [{ txid: COIN, vout: 0, satoshis: 1_000_000, confirmations: 3 }] }),
    [`/address/details/${myBch}`]: ok({ balanceSat: 1_000_000, unconfirmedBalanceSat: -200_000 }),
    ...extra, // a test's own answer for a path replaces the default; the catch-all '' comes last
  })
const sendBch = (n: ReturnType<typeof nodeAt>) => legacyUtxoAdapter(bch, UTXO_COINS.bch!, { fetch: n.fetchFn }).send({ kind: 'utxo-send', chainKey: 'bch', to: myBch, amount: 100_000n }, signer)
const pushRoute = (body: string, status = 200): Record<string, Handler> => ({ '': () => new Response(body, { status }) })

test('a Bitcoin Cash balance includes coins being spent right now', async () => {
  // 1 000 000 confirmed, 200 000 leaving in the mempool.
  assert.deepEqual(await legacyUtxoAdapter(bch, UTXO_COINS.bch!, { fetch: bchNode().fetchFn }).getBalances(myBch, [{ chainKey: 'bch', address: 'bitcoincash', symbol: 'BCH', decimals: 8 }]), [800_000n])
})

test('Bitcoin Cash coins without confirmations are not spent', async () => {
  const n = bchNode({ [`/address/utxo/${myBch}`]: ok({ utxos: [{ txid: COIN, vout: 0, satoshis: 1_000_000 }] }) })
  await assert.rejects(sendBch(n), /the wallet holds 0 \(confirmed\)/)
})

const BCH_TXID = 'b'.repeat(64)

test('a Bitcoin Cash broadcast returns the transaction id the node gives as a JSON string', async () => {
  // The push goes to /rawtransactions/sendRawTransaction/<hex>, matched by the catch-all.
  assert.equal(await sendBch(bchNode(pushRoute(`"${BCH_TXID}"`))), BCH_TXID)
})

test('a Bitcoin Cash broadcast returns a transaction id given as plain text', async () => {
  assert.equal(await sendBch(bchNode(pushRoute(BCH_TXID))), BCH_TXID)
})

test('a Bitcoin Cash broadcast answered with a JSON string that is not a transaction id is a refusal', async () => {
  await assert.rejects(sendBch(bchNode(pushRoute('"missing inputs"'))), /^Error: The node refused the transaction: "missing inputs"$/)
})

test('a Bitcoin Cash broadcast answered with an error status is a refusal, even with an id-like body', async () => {
  await assert.rejects(sendBch(bchNode(pushRoute(`"${BCH_TXID}"`, 400))), /The node refused the transaction/)
})

test('a Bitcoin Cash broadcast answered with plain text is a refusal, with the text', async () => {
  const n = bchNode({ ...pushRoute('txn-mempool-conflict') })
  await assert.rejects(sendBch(n), /^Error: The node refused the transaction: txn-mempool-conflict$/)
})

test('a Bitcoin Cash broadcast answered with a JSON object is a refusal', async () => {
  const n = bchNode({ ...pushRoute('{"error":"bad-txns-inputs-missingorspent"}') })
  await assert.rejects(sendBch(n), /^Error: The node refused the transaction: \{"error":"bad-txns-inputs-missingorspent"\}$/)
})

// ---- confirmation ----

const settle = () => new Promise<void>((r) => setImmediate(r))
async function passWaits(timers: { tick: (ms: number) => void }, waits: number) {
  for (let i = 0; i < waits; i++) {
    await settle()
    timers.tick(30_000)
  }
}

test('a Dogecoin transaction with a confirmation counts as confirmed', async () => {
  const n = nodeAt({ '/txs/abc?limit=1': ok({ confirmations: 1 }) })
  assert.equal(await legacyUtxoAdapter(doge, UTXO_COINS.doge!, { fetch: n.fetchFn, blockcypher: true }).waitForConfirmation('abc'), true)
})

test('a Bitcoin Cash transaction with a confirmation counts as confirmed', async () => {
  const n = nodeAt({ '/transaction/details/abc': ok({ confirmations: 2 }) })
  assert.equal(await legacyUtxoAdapter(bch, UTXO_COINS.bch!, { fetch: n.fetchFn }).waitForConfirmation('abc'), true)
})

test('an unconfirmed transaction is checked again every 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let checks = 0
  const n = nodeAt({ '/txs/abc?limit=1': () => new Response(JSON.stringify({ confirmations: ++checks >= 3 ? 1 : 0 })) })
  const done = legacyUtxoAdapter(doge, UTXO_COINS.doge!, { fetch: n.fetchFn, blockcypher: true }).waitForConfirmation('abc')
  await passWaits(t.mock.timers, 2)
  assert.deepEqual([await done, checks], [true, 3])
})

test('pinning: a node error while waiting counts as "not yet" and is retried', async (t) => {
  // Guards today's degraded mode: a brief outage must not fail a transfer that is already sent.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let checks = 0
  const n = nodeAt({ '/txs/abc?limit=1': () => (++checks === 1 ? new Response('down', { status: 503 }) : new Response(JSON.stringify({ confirmations: 1 }))) })
  const done = legacyUtxoAdapter({ ...doge, rpcUrls: ['https://only.node/v1/doge/main'] }, UTXO_COINS.doge!, { fetch: n.fetchFn, blockcypher: true }).waitForConfirmation('abc')
  await passWaits(t.mock.timers, 1)
  assert.equal(await done, true)
})

test('a transaction still unconfirmed after 6 hours is reported with advice to check', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const n = nodeAt({ '/txs/abc?limit=1': ok({ confirmations: 0 }) })
  const done = legacyUtxoAdapter(doge, UTXO_COINS.doge!, { fetch: n.fetchFn, blockcypher: true }).waitForConfirmation('abc')
  await passWaits(t.mock.timers, 720)
  await assert.rejects(done, /^Error: Transaction abc is still unconfirmed after 6 hours\. Check an explorer; it may have been dropped\.$/)
})
