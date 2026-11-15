import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { base58 } from '@scure/base'
import { mnemonicToSeedSync } from '@scure/bip39'
import { getBase64Encoder, getTransactionDecoder } from '@solana/kit'
import { mnemonicToAccount } from 'viem/accounts'
import { BUILTIN_TEST_CHAINS, chainAddress, solanaAdapter, type Signer } from '../src/index.ts'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const signer: Signer = { evm: mnemonicToAccount(MNEMONIC), seed: mnemonicToSeedSync(MNEMONIC) }
const chain = BUILTIN_TEST_CHAINS.find((c) => c.key === 'sold')!
const me = chainAddress(signer, chain)
const RECIPIENT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'

/** A fake RPC node that records the transaction it is asked to broadcast. */
function fakeNode() {
  const sent: string[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    const { method, params } = JSON.parse(String(init!.body))
    const result =
      method === 'getLatestBlockhash'
        ? { value: { blockhash: base58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1000 } }
        : method === 'sendTransaction'
          ? (sent.push(params[0]), 'sig')
          : method === 'getBalance'
            ? { value: 5_000_000 }
            : null
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  }
  return { sent, fetchFn }
}

const decode = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire))

test('a SOL transfer is signed by the wallet and carries the memo', async () => {
  const node = fakeNode()
  const adapter = solanaAdapter(chain, { fetch: node.fetchFn })
  await adapter.send({ kind: 'solana-transfer', chainKey: 'sold', to: RECIPIENT, amount: 1234n, memo: 'swap:abc' }, signer)

  const tx = decode(node.sent[0]!)
  const signature = tx.signatures[me as keyof typeof tx.signatures]!
  assert.ok(ed25519.verify(signature, new Uint8Array(tx.messageBytes), base58.decode(me)), 'signature does not match the wallet key')
  const message = Buffer.from(tx.messageBytes)
  assert.ok(message.includes(Buffer.from('swap:abc')), 'memo missing')
  assert.ok(message.includes(Buffer.from(base58.decode(RECIPIENT))), 'recipient missing')
})

test('a prepared transaction is only signed when it asks for this wallet', async () => {
  const node = fakeNode()
  const adapter = solanaAdapter(chain, { fetch: node.fetchFn })
  // Build a transaction whose only required signer is someone else.
  const other = chainAddress({ evm: signer.evm, seed: mnemonicToSeedSync('legal winner thank year wave sausage worth useful legal winner thank yellow') }, chain)
  const foreign = await solanaAdapter(chain, { fetch: node.fetchFn }).send({ kind: 'solana-transfer', chainKey: 'sold', to: RECIPIENT, amount: 1n }, {
    evm: signer.evm,
    seed: mnemonicToSeedSync('legal winner thank year wave sausage worth useful legal winner thank yellow'),
  })
  assert.equal(foreign, 'sig')
  const theirTx = node.sent[0]!
  assert.ok(decode(theirTx).signatures[other as never])
  await assert.rejects(adapter.send({ kind: 'solana-tx', chainKey: 'sold', transaction: theirTx }, signer), /not this wallet/)
})

test('SOL balance is read from the node', async () => {
  const adapter = solanaAdapter(chain, { fetch: fakeNode().fetchFn })
  const sol = { chainKey: 'sold', address: '11111111111111111111111111111111', symbol: 'SOL', decimals: 9 }
  assert.deepEqual(await adapter.getBalances(me, [sol]), [5_000_000n])
})

test('a wallet without a seed cannot use Solana', async () => {
  const adapter = solanaAdapter(chain, { fetch: fakeNode().fetchFn })
  await assert.rejects(adapter.send({ kind: 'solana-transfer', chainKey: 'sold', to: RECIPIENT, amount: 1n }, { evm: signer.evm }), /single EVM private key/)
})
