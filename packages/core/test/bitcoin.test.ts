import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hex } from '@scure/base'
import { mnemonicToSeedSync } from '@scure/bip39'
import * as btc from '@scure/btc-signer'
import { mnemonicToAccount } from 'viem/accounts'
import { BUILTIN_TEST_CHAINS, bitcoinAdapter, chainAddress, UTXO_COINS, utxoKey, type Signer } from '../src/index.ts'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const seed = mnemonicToSeedSync(MNEMONIC)
const signer: Signer = { evm: mnemonicToAccount(MNEMONIC), seed }
const chain = BUILTIN_TEST_CHAINS.find((c) => c.key === 'btct')!
const net = UTXO_COINS.btct!.network
const me = chainAddress(signer, chain)
const THEM = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const STRANGER = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7'
const FUNDING_TXID = 'aa'.repeat(32)

/** A fake Esplora node holding one coin of 100 000 sats for the wallet. */
function fakeNode() {
  const broadcasts: string[] = []
  const fetchFn: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.replace(/^\/testnet4\/api/, '')
    const json = (v: unknown) => new Response(JSON.stringify(v))
    if (path === '/fee-estimates') return json({ '3': 2 })
    if (path === `/address/${me}/utxo`) return json([{ txid: FUNDING_TXID, vout: 0, value: 100_000 }])
    if (path === `/address/${me}`) return json({ chain_stats: { funded_txo_sum: 100_000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } })
    if (path === '/tx' && init?.method === 'POST') {
      broadcasts.push(String(init.body))
      return new Response('txid-of-broadcast')
    }
    return new Response('not found', { status: 404 })
  }
  return { broadcasts, fetchFn }
}

test('balance counts confirmed and pending coins', async () => {
  const adapter = bitcoinAdapter(chain, { fetch: fakeNode().fetchFn })
  assert.deepEqual(await adapter.getBalances(me, [{ chainKey: 'btct', address: 'bitcoin', symbol: 'tBTC', decimals: 8 }]), [100_000n])
})

test('a deposit with a memo pays the address, carries OP_RETURN and returns the change', async () => {
  const node = fakeNode()
  const adapter = bitcoinAdapter(chain, { fetch: node.fetchFn })
  const id = await adapter.send({ kind: 'utxo-send', chainKey: 'btct', to: THEM, amount: 30_000n, memo: '=:ETH.ETH:0xabc' }, signer)
  assert.equal(id, 'txid-of-broadcast')

  const tx = btc.Transaction.fromRaw(hex.decode(node.broadcasts[0]!), { allowUnknownOutputs: true })
  const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i))
  assert.equal(outs.length, 3)
  assert.equal(outs[0]!.amount, 30_000n)
  assert.equal(btc.Address(net).encode(btc.OutScript.decode(outs[0]!.script!)), THEM)
  assert.equal(new TextDecoder().decode((btc.Script.decode(outs[1]!.script!)[1] as Uint8Array)), '=:ETH.ETH:0xabc')
  assert.equal(outs[1]!.amount, 0n)
  const change = outs[2]!.amount!
  assert.ok(change > 60_000n && change < 70_000n, `change ${change}`)
  assert.equal(btc.Address(net).encode(btc.OutScript.decode(outs[2]!.script!)), me)
})

test('sending more than the wallet holds fails before anything is broadcast', async () => {
  const node = fakeNode()
  await assert.rejects(bitcoinAdapter(chain, { fetch: node.fetchFn }).send({ kind: 'utxo-send', chainKey: 'btct', to: THEM, amount: 99_999n }, signer), /Not enough/)
  assert.equal(node.broadcasts.length, 0)
})

/** A PSBT like the ones route sources return: spends the wallet's coin, pays `outputs`. */
function psbtPaying(outputs: [string, bigint][], inAmount = 100_000n): string {
  const key = utxoKey(seed, 'btct')
  const tx = new btc.Transaction()
  tx.addInput({ txid: FUNDING_TXID, index: 0, witnessUtxo: { script: btc.OutScript.encode(btc.Address(net).decode(key.address)), amount: inAmount } })
  for (const [address, amount] of outputs) tx.addOutputAddress(address, amount, net)
  return hex.encode(tx.toPSBT())
}

test('a prepared PSBT that pays the named address is signed and broadcast', async () => {
  const node = fakeNode()
  const adapter = bitcoinAdapter(chain, { fetch: node.fetchFn })
  await adapter.send({ kind: 'utxo-psbt', chainKey: 'btct', psbt: psbtPaying([[THEM, 30_000n], [me, 69_000n]]), to: THEM, amount: 30_000n }, signer)
  assert.equal(node.broadcasts.length, 1)
})

test('a prepared PSBT that pays someone else, or the wrong amount, is refused', async () => {
  const node = fakeNode()
  const adapter = bitcoinAdapter(chain, { fetch: node.fetchFn })
  const send = (psbt: string) => adapter.send({ kind: 'utxo-psbt', chainKey: 'btct', psbt, to: THEM, amount: 30_000n }, signer)
  await assert.rejects(send(psbtPaying([[THEM, 30_000n], [STRANGER, 60_000n]])), /other than the one the route named/)
  await assert.rejects(send(psbtPaying([[THEM, 90_000n]])), /route named/)
  await assert.rejects(send(psbtPaying([[THEM, 30_000n], [me, 20_000n]])), /fee/)
  assert.equal(node.broadcasts.length, 0)
})

test('address validation follows the network', () => {
  const adapter = bitcoinAdapter(chain, { fetch: fakeNode().fetchFn })
  assert.ok(adapter.validateAddress(THEM))
  assert.ok(!adapter.validateAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'))
})
