import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeFunctionData, parseAbi } from 'viem'
import { cctpProvider, type Chain, type QuoteRequest, type Token } from '../src/index.ts'

const chain = (key: string, id: number, testnet = false): Chain => ({ family: 'evm', key, id, name: key, nativeSymbol: 'ETH', rpcUrls: [], testnet })
const chains = [chain('bas', 8453), chain('arb', 42161), chain('eth', 1), chain('bast', 84532, true)]
const usdc = (chainKey: string, address: string): Token => ({ chainKey, address, symbol: 'USDC', decimals: 6 })
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const ME = '0x1111111111111111111111111111111111111111'
const request = (amount: bigint, from = usdc('bas', BASE_USDC), to = usdc('arb', ARB_USDC)): QuoteRequest => ({ from, to, amount, fromAddress: ME, toAddress: ME, slippage: 0.005 })

const FEES = [
  { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 56035, med: 57543, high: 59052 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 56035, med: 57543, high: 59052 } },
]
function fakeIris(messages: unknown = { messages: [] }) {
  const calls: string[] = []
  const fetchFn: typeof fetch = async (url) => {
    calls.push(String(url))
    const body = String(url).includes('/fees/') ? FEES : messages
    return new Response(JSON.stringify(body), { status: 200 })
  }
  return { fetchFn, calls }
}

test('quotes a fast and a standard transfer, fees taken out of the amount', async () => {
  const iris = fakeIris()
  const quotes = await cctpProvider(iris.fetchFn, chains).getQuotes(request(10_000_000n), 'cheapest')
  assert.equal(iris.calls[0], 'https://iris-api.circle.com/v2/burn/USDC/fees/6/3?forward=true')
  assert.deepEqual(quotes.map((q) => q.tool), ['cctp-fast', 'cctp-standard'])
  // 10 USDC burned: forward fee 0.057543 + 1.3 bps of 10 USDC (0.0013)
  assert.equal(quotes[0]!.toAmount, 10_000_000n - 57_543n - 1_300n)
  assert.equal(quotes[1]!.toAmount, 10_000_000n - 57_543n)
  assert.equal(quotes[0]!.toAmountMin, quotes[0]!.toAmount)
})

test('offers nothing for other tokens, same chain, mixed testnet and mainnet, or amounts below the fee', async () => {
  const provider = cctpProvider(fakeIris().fetchFn, chains)
  const weth = usdc('bas', '0x4200000000000000000000000000000000000006')
  assert.deepEqual(await provider.getQuotes(request(10_000_000n, weth), 'cheapest'), [])
  assert.deepEqual(await provider.getQuotes(request(10_000_000n, usdc('bas', BASE_USDC), usdc('bas', BASE_USDC)), 'cheapest'), [])
  assert.deepEqual(await provider.getQuotes(request(10_000_000n, usdc('bas', BASE_USDC), usdc('bast', '0x036CbD53842c5426634e7929541eC2318f3dCF7e')), 'cheapest'), [])
  assert.deepEqual(await provider.getQuotes(request(50_000n), 'cheapest'), [])
})

test('builds one approval-guarded burn with the forwarding hook', async () => {
  const provider = cctpProvider(fakeIris().fetchFn, chains)
  const [fast] = await provider.getQuotes(request(10_000_000n), 'cheapest')
  const [action] = await provider.buildActions(fast!)
  assert.equal(action!.kind, 'evm-tx')
  if (action!.kind !== 'evm-tx') return
  assert.equal(action.to, '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d')
  assert.deepEqual(action.approval, { token: BASE_USDC, spender: action.to, amount: 10_000_000n })
  const abi = parseAbi(['function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)'])
  const { args } = decodeFunctionData({ abi, data: action.data as `0x${string}` })
  assert.equal(args![0], 10_000_000n)
  assert.equal(args![1], 3)
  assert.equal(args![2], `0x${'0'.repeat(24)}${ME.slice(2)}`)
  assert.equal(args![5], 57_543n + 1_300n)
  assert.equal(args![6], 1000)
  assert.equal(args![7], '0x636374702d666f72776172640000000000000000000000000000000000000000')
})

test('status follows the forwarded mint', async () => {
  const ref = { srcDomain: 6, testnet: 0, expected: '1' }
  const wait = await cctpProvider(fakeIris({ messages: [{ status: 'pending_confirmations' }] }).fetchFn, chains).getStatus('0xabc', ref)
  assert.equal(wait.state, 'pending')
  const done = await cctpProvider(fakeIris({ messages: [{ status: 'complete', forwardTxHash: '0xdef' }] }).fetchFn, chains).getStatus('0xabc', ref)
  assert.deepEqual([done.state, done.destTxId], ['done', '0xdef'])
})
