import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeFunctionData, type Hex } from 'viem'
import { cctpProvider, type Chain, type EvmTxAction, type QuoteRequest, type Token } from '../src/index.ts'

// ---- fixtures ----

const chain = (key: string, id: number, testnet = false, family: Chain['family'] = 'evm'): Chain => ({ family, key, id, name: key, nativeSymbol: 'ETH', rpcUrls: [], testnet })
const chains = [chain('bas', 8453), chain('arb', 42161), chain('bast', 84532, true), chain('arbs', 421614, true)]
const usdc = (chainKey: string, address: string): Token => ({ chainKey, address, symbol: 'USDC', decimals: 6 })
const BASE_USDC = usdc('bas', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const ARB_USDC = usdc('arb', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831')
const BASE_SEPOLIA_USDC = usdc('bast', '0x036CbD53842c5426634e7929541eC2318f3dCF7e')
const ARB_SEPOLIA_USDC = usdc('arbs', '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d')
const ME = '0x1111111111111111111111111111111111111111'
const request = (amount: bigint, from = BASE_USDC, to = ARB_USDC, toAddress = ME): QuoteRequest => ({ from, to, amount, fromAddress: ME, toAddress, slippage: 0.005 })

/** Circle's fee table as Iris returns it: fast (1000) at 1.3 bps, standard (2000) free, plus the forwarding fee. */
const FAST = { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 56_035, med: 57_543, high: 59_052 } }
const STANDARD = { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 56_035, med: 57_543, high: 59_052 } }

/** Iris at the fetch boundary: the fee table for fee requests, `messages` for status requests. */
function iris(fees: unknown[] = [FAST, STANDARD], messages: unknown = { messages: [] }) {
  const urls: string[] = []
  const fetchFn = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify(url.includes('/fees/') ? fees : messages))
  }) as typeof fetch
  return { fetchFn, urls }
}
const quotesFor = (req: QuoteRequest, fees?: unknown[]) => cctpProvider(iris(fees).fetchFn, chains).getQuotes(req, 'cheapest')

// ---- fees ----

test('a protocol fee with a fraction of a base unit is rounded up, so the fee limit always covers it', async () => {
  // 1.3 bps of 10.000001 USDC = 1300.00013 base units -> 1301; received = 10_000_001 - 57_543 - 1_301.
  const [fast] = await quotesFor(request(10_000_001n), [FAST])
  assert.equal(fast!.toAmount, 9_941_157n)
})

test('an amount exactly equal to the fee is not quoted, as nothing would arrive', async () => {
  assert.deepEqual(await quotesFor(request(57_543n), [STANDARD]), [])
})

test('an amount one base unit above the fee is quoted, with one base unit arriving', async () => {
  const [standard] = await quotesFor(request(57_544n), [STANDARD])
  assert.equal(standard!.toAmount, 1n)
})

test('when the "high" forwarding fee would eat the whole amount, the worst case is the expected amount', async () => {
  // 58 000 base units: 457 arrive at the "med" fee; the "high" fee (59 052) is above the amount.
  const [standard] = await quotesFor(request(58_000n), [STANDARD])
  assert.equal(standard!.toAmountMin, 457n)
})

test('finality levels other than fast and standard are ignored', async () => {
  assert.deepEqual(await quotesFor(request(10_000_000n), [{ ...FAST, finalityThreshold: 1500 }]), [])
})

test('the expected amount is in USD at a dollar per USDC', async () => {
  const [standard] = await quotesFor(request(10_000_000n), [STANDARD])
  assert.equal(standard!.toAmountUsd, 9.942457) // 10 - 0.057543
})

test('pinning: when the source chain’s gas price cannot be read, the route’s gas cost counts as $0', async () => {
  // The chains here have no RPC endpoints, so the estimate is unknown. Guards today's degraded mode.
  const [standard] = await quotesFor(request(10_000_000n), [STANDARD])
  assert.equal(standard!.costUsd, 0)
})

// ---- which transfers CCTP offers ----

test('a source chain the app does not know offers nothing', async () => {
  assert.deepEqual(await quotesFor(request(10_000_000n, usdc('zzz', BASE_USDC.address))), [])
})

test('a known chain that is not an EVM chain offers nothing', async () => {
  const solanaNamedLikeBase = [chain('bas', 8453, false, 'solana'), chain('arb', 42161)]
  assert.deepEqual(await cctpProvider(iris().fetchFn, solanaNamedLikeBase).getQuotes(request(10_000_000n), 'cheapest'), [])
})

test('USDC addresses are compared without regard to letter case', async () => {
  const lower = usdc('bas', BASE_USDC.address.toLowerCase())
  assert.equal((await quotesFor(request(10_000_000n, lower), [STANDARD])).length, 1)
})

test('a transfer between two test networks asks Circle’s sandbox for fees', async () => {
  const api = iris([STANDARD])
  await cctpProvider(api.fetchFn, chains).getQuotes(request(10_000_000n, BASE_SEPOLIA_USDC, ARB_SEPOLIA_USDC), 'cheapest')
  assert.equal(api.urls[0], 'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/6/3?forward=true')
})

// ---- the burn transaction ----

const burnArgs = (action: EvmTxAction) =>
  decodeFunctionData({ abi: [{ type: 'function', name: 'depositForBurnWithHook', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' }, { name: 'burnToken', type: 'address' }, { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' }, { name: 'hookData', type: 'bytes' }], outputs: [] }], data: action.data as Hex }).args

test('the burn limits Circle’s fee to the quoted maximum and asks for the quoted finality', async () => {
  const provider = cctpProvider(iris([FAST]).fetchFn, chains)
  const [fast] = await provider.getQuotes(request(10_000_000n), 'cheapest')
  const [action] = (await provider.buildActions!(fast!)) as EvmTxAction[]
  // maxFee = 57 543 forwarding + 1 300 protocol
  assert.deepEqual([burnArgs(action!)[5], burnArgs(action!)[6]], [58_843n, 1000])
})

test('a burn on a test network goes to the testnet token messenger', async () => {
  const provider = cctpProvider(iris([STANDARD]).fetchFn, chains)
  const [q] = await provider.getQuotes(request(10_000_000n, BASE_SEPOLIA_USDC, ARB_SEPOLIA_USDC), 'cheapest')
  const [action] = (await provider.buildActions!(q!)) as EvmTxAction[]
  assert.equal(action!.to, '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA')
})

test('a burn on a main network goes to the mainnet token messenger', async () => {
  const provider = cctpProvider(iris([STANDARD]).fetchFn, chains)
  const [q] = await provider.getQuotes(request(10_000_000n), 'cheapest')
  const [action] = (await provider.buildActions!(q!)) as EvmTxAction[]
  assert.equal(action!.to, '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d')
})

test('a recipient that is not an EVM address is refused before anything is built', async () => {
  const provider = cctpProvider(iris([STANDARD]).fetchFn, chains)
  const [q] = await provider.getQuotes(request(10_000_000n, BASE_USDC, ARB_USDC, '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), 'cheapest')
  await assert.rejects(provider.buildActions!(q!), /^Error: The CCTP destination must be an EVM address$/)
})

// ---- status ----

const statusWith = (messages: unknown) => cctpProvider(iris([], messages).fetchFn, chains).getStatus('0xabc', { srcDomain: 6, testnet: 0, expected: '1' })

test('a burn Circle has not seen yet is waited for', async () => {
  assert.deepEqual(await statusWith({ messages: [] }), { state: 'pending', detail: 'Waiting for Circle to see the burn' })
})

test('a burn waiting for confirmations is waiting for the attestation', async () => {
  assert.deepEqual(await statusWith({ messages: [{ status: 'pending_confirmations' }] }), { state: 'pending', detail: 'Waiting for the attestation' })
})

test('an attested burn not yet minted is waiting for the mint', async () => {
  assert.deepEqual(await statusWith({ messages: [{ status: 'complete' }] }), { state: 'pending', detail: 'Attested; waiting for the mint on the destination chain' })
})

test('a forwarding failure is reported with how the USDC can still be recovered', async () => {
  const s = await statusWith({ messages: [{ status: 'complete', forwardState: 'failed' }] })
  assert.deepEqual(s, { state: 'failed', detail: 'The Forwarding Service reported a failure; the USDC is burned and can still be minted by hand with the attestation' })
})
