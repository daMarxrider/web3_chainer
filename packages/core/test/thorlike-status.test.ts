import assert from 'node:assert/strict'
import { test } from 'node:test'
import { THORCHAIN, thorProvider, type Chain, type Token } from '../src/index.ts'

const chains: Chain[] = [{ family: 'evm', key: 'eth', id: 1, name: 'Ethereum', nativeSymbol: 'ETH', rpcUrls: [], testnet: false, nativePriceUsd: 2000 }]
const USDC: Token = { chainKey: 'eth', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 }
const BTC: Token = { chainKey: 'btc', address: 'bitcoin', symbol: 'BTC', decimals: 8 }
const VAULT = '0x0d15b57a5ba0a31a4774c03ddfacf79b289db9ce'
const TX = 'ab'.repeat(32)

/** A THORNode answering /tx/status with the given body (or status code) and recording the path asked. */
function statusNode(answer: unknown, status = 200) {
  const paths: string[] = []
  const fetchFn = (async (url: string) => {
    paths.push(new URL(url).pathname)
    return new Response(JSON.stringify(answer), { status })
  }) as typeof fetch
  return { fetchFn, paths }
}
const statusOf = (answer: unknown, status = 200, txId = `0x${TX}`, toDecimals = 6) => {
  const n = statusNode(answer, status)
  return { result: thorProvider(n.fetchFn, THORCHAIN, chains).getStatus(txId, { toDecimals }), paths: n.paths }
}
const stages = (s: Record<string, unknown>) => ({ stages: { inbound_observed: { completed: true }, inbound_finalised: { completed: true }, swap_finalised: { completed: true }, ...s } })

// ---- asking ----

test('an EVM transaction hash is asked for without 0x and in capitals', async () => {
  const { result, paths } = statusOf(stages({}))
  await result
  assert.equal(paths[0], `/chain/thorchain_api/thorchain/tx/status/${TX.toUpperCase()}`)
})

test('a transaction id that is not 64 hex digits (a Solana signature) is asked for as it is', async () => {
  const sig = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
  const { result, paths } = statusOf(stages({}), 200, sig)
  await result
  assert.equal(paths[0], `/chain/thorchain_api/thorchain/tx/status/${sig}`)
})

test('a deposit the node does not know yet is waited for', async () => {
  assert.deepEqual(await statusOf({ message: 'not found' }, 404).result, { state: 'pending', detail: 'Waiting for the network to see the deposit' })
})

test('a node that fails for another reason keeps the transfer pending and says why', async () => {
  assert.deepEqual(await statusOf({ message: 'internal error' }, 500).result, { state: 'pending', detail: 'Could not reach thorchain (gateway.liquify.com responded 500: internal error); trying again' })
})

// ---- stages ----

test('a deposit not yet observed is waited for', async () => {
  assert.deepEqual(await statusOf({ stages: { inbound_observed: { completed: false } } }).result, { state: 'pending', detail: 'Waiting for the network to see the deposit' })
})

test('an observed deposit waiting for confirmations says so', async () => {
  assert.deepEqual(await statusOf({ stages: { inbound_observed: { completed: true }, inbound_finalised: { completed: false } } }).result, { state: 'pending', detail: 'Deposit seen, waiting for confirmations' })
})

test('a swap still in progress says so', async () => {
  assert.deepEqual(await statusOf(stages({ swap_status: { pending: true } })).result, { state: 'pending', detail: 'Swapping' })
})

test('a swap not yet final says so', async () => {
  assert.deepEqual(await statusOf(stages({ swap_finalised: { completed: false } })).result, { state: 'pending', detail: 'Swapping' })
})

test('a finished swap whose payout is not signed yet is sending the payout', async () => {
  assert.deepEqual(await statusOf(stages({ outbound_signed: { completed: false } })).result, { state: 'pending', detail: 'Swap done, sending the payout' })
})

test('a finished swap without a signing stage and without a payout yet is sending the payout', async () => {
  assert.deepEqual(await statusOf(stages({})).result, { state: 'pending', detail: 'Swap done, sending the payout' })
})

test('a refund is a failed transfer that says the deposit went back', async () => {
  const answer = { ...stages({ outbound_signed: { completed: true } }), out_txs: [{ id: 'OUT', coins: [{ asset: 'ETH.USDC', amount: '100' }] }], planned_out_txs: [{ refund: true }] }
  assert.deepEqual(await statusOf(answer).result, { state: 'failed', detail: 'thorchain refunded the deposit to the sender' })
})

test('a paid-out swap reports the amount in the token’s decimals and the payout transaction', async () => {
  // 150 000 000 in the network's 8 decimals = 1.5 USDC = 1 500 000 at 6 decimals.
  const answer = { ...stages({ outbound_signed: { completed: true } }), out_txs: [{ id: 'PAYOUT', coins: [{ asset: 'ETH.USDC', amount: '150000000' }] }], planned_out_txs: [{ refund: false }] }
  assert.deepEqual(await statusOf(answer).result, { state: 'done', receivedAmount: 1_500_000n, destTxId: 'PAYOUT' })
})

test('a payout without coins listed leaves the amount unknown', async () => {
  const answer = { ...stages({}), out_txs: [{ id: 'PAYOUT', coins: [] }] }
  assert.deepEqual(await statusOf(answer).result, { state: 'done', receivedAmount: undefined, destTxId: 'PAYOUT' })
})

// ---- token deposits ----

test('a token deposit on a chain the node lists no router for is refused', async () => {
  const fetchFn = (async (url: string) => {
    const path = new URL(url).pathname
    if (path.endsWith('/pools')) return new Response(JSON.stringify([{ asset: `ETH.USDC-${USDC.address.toUpperCase()}`, status: 'Available' }, { asset: 'BTC.BTC', status: 'Available' }]))
    if (path.endsWith('/inbound_addresses')) return new Response(JSON.stringify([{ chain: 'ETH', address: VAULT, halted: false }]))
    return new Response(JSON.stringify({ inbound_address: VAULT, expiry: 0, memo: '=:b:bc1q', expected_amount_out: '1000', recommended_min_amount_in: '1', fees: { total: '1' } }))
  }) as typeof fetch
  const p = thorProvider(fetchFn, THORCHAIN, chains)
  const [q] = await p.getQuotes({ from: USDC, to: BTC, amount: 1_000_000n, fromAddress: '0xme', toAddress: 'bc1q', slippage: 0.01 }, 'cheapest')
  await assert.rejects(p.buildActions!(q!), /^Error: thorchain lists no router for ETH$/)
})
