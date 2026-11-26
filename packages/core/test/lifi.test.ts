import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUILTIN_CHAINS, lifiAction, lifiChains, lifiProvider, lifiToken, lifiTokens, normalizeLifiStep, type Chain, type LifiStep, type Quote, type QuoteRequest, type Token } from '../src/index.ts'

// Each test file runs in its own process, so lifi.ts's memory of which Bitcoin-family chains
// LI.FI lists starts empty here. Dogecoin is never listed in this file.

// ---- fixtures ----

const arbitrum = { family: 'evm', key: 'arb', id: 42161, name: 'Arbitrum', nativeSymbol: 'ETH', rpcUrls: ['https://arb.example'], testnet: false } as Chain
const base = { family: 'evm', key: 'bas', id: 8453, name: 'Base', nativeSymbol: 'ETH', rpcUrls: ['https://base.example'], testnet: false } as Chain
const solana = { family: 'solana', key: 'sol', id: 1151111081099710, name: 'Solana', nativeSymbol: 'SOL', rpcUrls: ['https://sol.example'], testnet: false } as Chain
const dogecoin = BUILTIN_CHAINS.find((c) => c.key === 'doge')!

const usdcArb: Token = { chainKey: 'arb', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 }
const usdcBase: Token = { chainKey: 'bas', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }
const ethArb: Token = { chainKey: 'arb', address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 }
const solToken: Token = { chainKey: 'sol', address: '11111111111111111111111111111111', symbol: 'SOL', decimals: 9 }

const request = (from: Token = usdcArb, to: Token = usdcBase): QuoteRequest => ({ from, to, amount: 100_000_000n, fromAddress: '0x1111111111111111111111111111111111111111', toAddress: '0x2222222222222222222222222222222222222222', slippage: 0.005 })

/** A one-transaction LI.FI step; each test overrides the part it is about. */
function step(over: { estimate?: Partial<LifiStep['estimate']>; transactionRequest?: LifiStep['transactionRequest'] | null; includedSteps?: LifiStep['includedSteps']; tool?: string; fromChainId?: number; toChainId?: number } = {}): LifiStep {
  const lifiToken = (t: Token, chainId: number) => ({ address: t.address, chainId, symbol: t.symbol, decimals: t.decimals })
  return {
    tool: over.tool ?? 'across',
    action: { fromToken: lifiToken(usdcArb, 42161), toToken: lifiToken(usdcBase, 8453), fromChainId: over.fromChainId ?? 42161, toChainId: over.toChainId ?? 8453 },
    estimate: { approvalAddress: '0x3333333333333333333333333333333333333333', toAmount: '99750000', toAmountMin: '99250000', executionDuration: 60, ...over.estimate },
    includedSteps: over.includedSteps,
    transactionRequest: over.transactionRequest === null ? undefined : (over.transactionRequest ?? { to: '0x4444444444444444444444444444444444444444', data: '0xdead', value: '0x0' }),
  }
}

/** The LI.FI API at the fetch boundary: answers by path and records each request. */
function lifiApi(answers: Record<string, unknown | ((body: unknown) => unknown)>, status = 200) {
  const calls: { path: string; query: URLSearchParams; body?: unknown }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: u.pathname, query: u.searchParams, body })
    const answer = answers[u.pathname]
    if (answer === undefined) return new Response(JSON.stringify({ message: `no fake for ${u.pathname}` }), { status: 404 })
    return new Response(JSON.stringify(typeof answer === 'function' ? (answer as (b: unknown) => unknown)(body) : answer), { status })
  }) as typeof fetch
  return { fetchFn, calls }
}
const noBridgeSettings = { lifi: { allowBridges: [], denyBridges: [] } }

// ---- chains ----

const lifiChain = (over: Record<string, unknown>) => ({ chainType: 'EVM', key: 'arb', id: 42161, name: 'Arbitrum', mainnet: true, multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11', nativeToken: { address: '0x0000000000000000000000000000000000000000', chainId: 42161, symbol: 'ETH', decimals: 18, priceUSD: '3000.5' }, metamask: { rpcUrls: ['https://lifi-listed.example'] }, ...over })

test('an EVM chain from LI.FI keeps its id, name, coin, coin price and multicall contract', async () => {
  const { fetchFn } = lifiApi({ '/v1/chains': { chains: [lifiChain({})] } })
  const [arb] = await lifiChains(fetchFn)
  assert.deepEqual([arb!.family, arb!.key, arb!.id, arb!.name, arb!.nativeSymbol, arb!.nativePriceUsd, arb!.multicall], ['evm', 'arb', 42161, 'Arbitrum', 'ETH', 3000.5, '0xcA11bde05977b3631167028862bE2a173976CA11'])
})

test('a chain LI.FI marks as not mainnet is a test network', async () => {
  const { fetchFn } = lifiApi({ '/v1/chains': { chains: [lifiChain({ mainnet: false })] } })
  assert.equal((await lifiChains(fetchFn))[0]!.testnet, true)
})

test('a coin without a price has no price, not a price of zero', async () => {
  const { fetchFn } = lifiApi({ '/v1/chains': { chains: [lifiChain({ nativeToken: { address: '0x0', chainId: 42161, symbol: 'ETH', decimals: 18 } })] } })
  assert.equal((await lifiChains(fetchFn))[0]!.nativePriceUsd, undefined)
})

test('chain types the app has no adapter for (Sui, Tron) are left out', async () => {
  const { fetchFn } = lifiApi({ '/v1/chains': { chains: [lifiChain({ chainType: 'MVM', key: 'sui' }), lifiChain({ chainType: 'TVM', key: 'trx' }), lifiChain({})] } })
  assert.deepEqual((await lifiChains(fetchFn)).map((c) => c.key), ['arb'])
})

test('a Bitcoin-family chain the app has no coin definition for is left out', async () => {
  const { fetchFn } = lifiApi({ '/v1/chains': { chains: [lifiChain({ chainType: 'UTXO', key: 'zec' })] } })
  assert.deepEqual(await lifiChains(fetchFn), [])
})

test('Bitcoin is read through its Esplora endpoints, not the JSON-RPC nodes LI.FI lists', async () => {
  const { fetchFn } = lifiApi({ '/v1/chains': { chains: [lifiChain({ chainType: 'UTXO', key: 'btc', id: 20000000000001 })] } })
  const [btc] = await lifiChains(fetchFn)
  assert.deepEqual([btc!.family, btc!.rpcUrls.includes('https://lifi-listed.example')], ['bitcoin', false])
})

// ---- tokens ----

test('a token is looked up by symbol on the chain’s id, with the symbol URL-encoded', async () => {
  const { fetchFn, calls } = lifiApi({ '/v1/token': { address: usdcArb.address, chainId: 42161, symbol: 'USDC.e', decimals: 6 } })
  await lifiToken(fetchFn, arbitrum, 'USDC.e & co')
  assert.deepEqual([calls[0]!.query.get('chain'), calls[0]!.query.get('token')], ['42161', 'USDC.e & co'])
})

test('a looked-up token carries its name, price and LI.FI’s screening verdict', async () => {
  const { fetchFn } = lifiApi({ '/v1/token': { address: usdcArb.address, chainId: 42161, symbol: 'USDC', decimals: 6, name: 'USD Coin', priceUSD: '0.9998', verificationStatus: 'verified' } })
  assert.deepEqual(await lifiToken(fetchFn, arbitrum, 'USDC'), { chainKey: 'arb', address: usdcArb.address, symbol: 'USDC', decimals: 6, name: 'USD Coin', priceUsd: 0.9998, screening: 'verified' })
})

test('a screening verdict the app does not know is ignored rather than trusted', async () => {
  const { fetchFn } = lifiApi({ '/v1/token': { address: usdcArb.address, chainId: 42161, symbol: 'USDC', decimals: 6, verificationStatus: 'pending-review' } })
  assert.equal((await lifiToken(fetchFn, arbitrum, 'USDC')).screening, undefined)
})

test('a token missing on the chain surfaces LI.FI’s 404 with the service named', async () => {
  const { fetchFn } = lifiApi({})
  await assert.rejects(lifiToken(fetchFn, arbitrum, 'WETH'), /^Error: li\.quest responded 404/)
})

test('Dogecoin’s own coin is answered without asking LI.FI, in any letter case', async () => {
  const { fetchFn, calls } = lifiApi({})
  const doge = await lifiToken(fetchFn, dogecoin, 'doge')
  assert.deepEqual([doge.symbol, calls.length], ['DOGE', 0])
})

test('any other token on Dogecoin is refused, naming the only coin there', async () => {
  const { fetchFn } = lifiApi({})
  await assert.rejects(lifiToken(fetchFn, dogecoin, 'USDC'), /^Error: Dogecoin only has its own coin \(DOGE\) here$/)
})

test('the token list of Dogecoin is its own coin, without asking LI.FI', async () => {
  const { fetchFn, calls } = lifiApi({})
  assert.deepEqual([(await lifiTokens(fetchFn, dogecoin)).map((t) => t.symbol), calls.length], [['DOGE'], 0])
})

test('a chain missing from LI.FI’s token answer has no tokens', async () => {
  const { fetchFn } = lifiApi({ '/v1/tokens': { tokens: {} } })
  assert.deepEqual(await lifiTokens(fetchFn, arbitrum), [])
})

test('the token list is taken from the entry for the chain’s id', async () => {
  const { fetchFn } = lifiApi({ '/v1/tokens': { tokens: { '42161': [{ address: usdcArb.address, chainId: 42161, symbol: 'USDC', decimals: 6 }], '8453': [{ address: usdcBase.address, chainId: 8453, symbol: 'USDC', decimals: 6 }] } } })
  assert.deepEqual((await lifiTokens(fetchFn, arbitrum)).map((t) => t.address), [usdcArb.address])
})

// ---- quotes from a step ----

test('gas costs all count against the route', () => {
  const q = normalizeLifiStep(step({ estimate: { gasCosts: [{ amountUSD: '0.10' }, { amountUSD: '0.05' }] } }), request())
  assert.equal(q.costUsd, 0.15000000000000002) // 0.10 + 0.05 in floating point
})

test('a fee LI.FI says is not included in the amount counts against the route', () => {
  const q = normalizeLifiStep(step({ estimate: { feeCosts: [{ amountUSD: '0.40', included: false }] } }), request())
  assert.equal(q.costUsd, 0.4)
})

test('a fee already taken out of the amount is not counted a second time', () => {
  const q = normalizeLifiStep(step({ estimate: { feeCosts: [{ amountUSD: '0.25', included: true }] } }), request())
  assert.equal(q.costUsd, 0)
})

test('pinning: a fee without an "included" flag is assumed to be taken out of the amount already', () => {
  // Guards today's reading of LI.FI's data; if LI.FI starts omitting the flag for extra fees, this is the place to change.
  const q = normalizeLifiStep(step({ estimate: { feeCosts: [{ amountUSD: '0.25' }] } }), request())
  assert.equal(q.costUsd, 0)
})

test('a cost without a USD amount counts as zero rather than breaking the sum', () => {
  const q = normalizeLifiStep(step({ estimate: { gasCosts: [{}, { amountUSD: '0.02' }] } }), request())
  assert.equal(q.costUsd, 0.02)
})

test('amounts too large for a JavaScript number are kept exact', () => {
  // 2^70 base units; Number() would round it.
  const q = normalizeLifiStep(step({ estimate: { toAmount: '1180591620717411303424', toAmountMin: '1180591620717411303423' } }), request())
  assert.deepEqual([q.toAmount, q.toAmountMin], [1180591620717411303424n, 1180591620717411303423n])
})

test('a step without a USD value for the amount received has none, not zero', () => {
  assert.equal(normalizeLifiStep(step(), request()).toAmountUsd, undefined)
})

test('the tokens a route passes through are listed once each', () => {
  const t = (symbol: string) => ({ address: '0x0', chainId: 1, symbol, decimals: 6 })
  const q = normalizeLifiStep(step({ includedSteps: [{ action: { fromToken: t('USDC'), toToken: t('USDT') } }, { action: { fromToken: t('USDT'), toToken: t('USDC') } }] }), request())
  assert.deepEqual(q.viaSymbols, ['USDC', 'USDT'])
})

test('a step without included steps passes through no tokens', () => {
  assert.deepEqual(normalizeLifiStep(step(), request()).viaSymbols, [])
})

// ---- transactions from a step ----

test('an ERC-20 transfer asks for an approval of exactly the amount, for LI.FI’s approval address', () => {
  const action = lifiAction(step(), request())
  assert.deepEqual(action.kind === 'evm-tx' && action.approval, { token: usdcArb.address, spender: '0x3333333333333333333333333333333333333333', amount: 100_000_000n })
})

test('sending the chain’s coin needs no approval', () => {
  const action = lifiAction(step(), request(ethArb))
  assert.equal(action.kind === 'evm-tx' && action.approval, undefined)
})

test('a transaction without a value sends no coin', () => {
  const action = lifiAction(step({ transactionRequest: { to: '0x4444444444444444444444444444444444444444', data: '0x' } }), request())
  assert.equal(action.kind === 'evm-tx' && action.value, 0n)
})

test('a transaction without a gas limit leaves it to the estimate', () => {
  const action = lifiAction(step(), request())
  assert.equal(action.kind === 'evm-tx' && action.gasLimit, undefined)
})

test('an EVM transaction without a recipient is refused', () => {
  assert.throws(() => lifiAction(step({ transactionRequest: { data: '0xdead' } }), request()), /^Error: LI\.FI returned an EVM transaction without a recipient$/)
})

test('a step without any transaction is refused', () => {
  assert.throws(() => lifiAction(step({ transactionRequest: null }), request()), /^Error: LI\.FI returned no transaction for this route$/)
})

test('a Solana step becomes a prepared Solana transaction', () => {
  const action = lifiAction(step({ transactionRequest: { data: 'AQID' } }), request(solToken), 'solana')
  assert.deepEqual(action, { kind: 'solana-tx', chainKey: 'sol', transaction: 'AQID' })
})

test('a Bitcoin step becomes a PSBT with its recipient and exact amount', () => {
  const btc: Token = { chainKey: 'btc', address: 'bitcoin', symbol: 'BTC', decimals: 8 }
  const action = lifiAction(step({ transactionRequest: { to: 'bc1qrecipient', data: 'cHNidP8', value: '250000' } }), request(btc), 'bitcoin')
  assert.deepEqual(action, { kind: 'utxo-psbt', chainKey: 'btc', psbt: 'cHNidP8', to: 'bc1qrecipient', amount: 250000n })
})

test('a Bitcoin step without an amount is refused', () => {
  const btc: Token = { chainKey: 'btc', address: 'bitcoin', symbol: 'BTC', decimals: 8 }
  assert.throws(() => lifiAction(step({ transactionRequest: { to: 'bc1qrecipient', data: 'cHNidP8' } }), request(btc), 'bitcoin'), /without a recipient or amount/)
})

test('a Bitcoin step without a recipient is refused', () => {
  const btc: Token = { chainKey: 'btc', address: 'bitcoin', symbol: 'BTC', decimals: 8 }
  assert.throws(() => lifiAction(step({ transactionRequest: { data: 'cHNidP8', value: '1' } }), request(btc), 'bitcoin'), /without a recipient or amount/)
})

// ---- the provider ----

type RoutesBody = { fromChainId: number; toChainId: number; fromTokenAddress: string; toTokenAddress: string; fromAmount: string; fromAddress: string; toAddress: string; options: { slippage: number; order: string; allowSwitchChain: boolean; bridges: { allow?: string[]; deny?: string[] } } }
const routesBody = (calls: { body?: unknown }[]) => calls[0]!.body as RoutesBody

test('a route search sends the chain ids, token addresses, exact amount, both addresses and the slippage', async () => {
  const { fetchFn, calls } = lifiApi({ '/v1/advanced/routes': { routes: [] } })
  await lifiProvider(fetchFn, [arbitrum, base], noBridgeSettings).getQuotes(request(), 'cheapest')
  const b = routesBody(calls)
  assert.deepEqual([b.fromChainId, b.toChainId, b.fromTokenAddress, b.toTokenAddress, b.fromAmount, b.fromAddress, b.toAddress, b.options.slippage], [42161, 8453, usdcArb.address, usdcBase.address, '100000000', '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 0.005])
})

test('a search for the fastest route asks LI.FI to order by speed', async () => {
  const { fetchFn, calls } = lifiApi({ '/v1/advanced/routes': { routes: [] } })
  await lifiProvider(fetchFn, [arbitrum, base], noBridgeSettings).getQuotes(request(), 'fastest')
  assert.equal(routesBody(calls).options.order, 'FASTEST')
})

test('a search for the cheapest route asks LI.FI to order by price', async () => {
  const { fetchFn, calls } = lifiApi({ '/v1/advanced/routes': { routes: [] } })
  await lifiProvider(fetchFn, [arbitrum, base], noBridgeSettings).getQuotes(request(), 'cheapest')
  assert.equal(routesBody(calls).options.order, 'CHEAPEST')
})

test('a search never allows routes that need a second transaction on another chain', async () => {
  const { fetchFn, calls } = lifiApi({ '/v1/advanced/routes': { routes: [] } })
  await lifiProvider(fetchFn, [arbitrum, base], noBridgeSettings).getQuotes(request(), 'cheapest')
  assert.equal(routesBody(calls).options.allowSwitchChain, false)
})

test('empty allow and deny lists are left out, so LI.FI may use every bridge', async () => {
  const { fetchFn, calls } = lifiApi({ '/v1/advanced/routes': { routes: [] } })
  await lifiProvider(fetchFn, [arbitrum, base], noBridgeSettings).getQuotes(request(), 'cheapest')
  assert.deepEqual(routesBody(calls).options.bridges, {})
})

test('the allow and deny lists from the settings are sent as they are', async () => {
  const { fetchFn, calls } = lifiApi({ '/v1/advanced/routes': { routes: [] } })
  await lifiProvider(fetchFn, [arbitrum, base], { lifi: { allowBridges: ['across', 'stargate'], denyBridges: ['paxos'] } }).getQuotes(request(), 'cheapest')
  assert.deepEqual(routesBody(calls).options.bridges, { allow: ['across', 'stargate'], deny: ['paxos'] })
})

test('routes of more than one step are dropped, single-step ones kept', async () => {
  const { fetchFn } = lifiApi({ '/v1/advanced/routes': { routes: [{ steps: [step({ tool: 'two-a' }), step({ tool: 'two-b' })] }, { steps: [step({ tool: 'single' })] }] } })
  const quotes = await lifiProvider(fetchFn, [arbitrum, base], noBridgeSettings).getQuotes(request(), 'cheapest')
  assert.deepEqual(quotes.map((q) => q.tool), ['single'])
})

test('a chain LI.FI was not told about is refused before any request', async () => {
  const { fetchFn, calls } = lifiApi({})
  await assert.rejects(lifiProvider(fetchFn, [arbitrum], noBridgeSettings).getQuotes(request(), 'cheapest'), /^Error: LI\.FI does not know chain "bas"$/)
  assert.equal(calls.length, 0)
})

test('building the transaction sends the chosen step back to LI.FI unchanged', async () => {
  const chosen = step({ tool: 'stargate' })
  const { fetchFn, calls } = lifiApi({ '/v1/advanced/stepTransaction': chosen })
  await lifiProvider(fetchFn, [arbitrum, base], noBridgeSettings).buildActions!(normalizeLifiStep(chosen, request()))
  assert.deepEqual(calls[0]!.body, JSON.parse(JSON.stringify(chosen)))
})

test('a route from Solana is built as a Solana transaction', async () => {
  const { fetchFn } = lifiApi({ '/v1/advanced/stepTransaction': step({ transactionRequest: { data: 'AQID' } }) })
  const quote = normalizeLifiStep(step(), request(solToken))
  const [action] = await lifiProvider(fetchFn, [solana, base], noBridgeSettings).buildActions!(quote)
  assert.equal(action!.kind, 'solana-tx')
})

// ---- status ----

const statusOf = async (answer: unknown, ref: Quote['statusRef'] = { tool: 'across', fromChain: 42161, toChain: 8453 }, status = 200) => {
  const api = lifiApi({ '/v1/status': answer }, status)
  const result = await lifiProvider(api.fetchFn, [arbitrum, base], noBridgeSettings).getStatus('0xabc', ref)
  return { result, query: api.calls[0]!.query }
}

test('a cross-chain status request names the bridge', async () => {
  const { query } = await statusOf({ status: 'PENDING' })
  assert.deepEqual([query.get('txHash'), query.get('fromChain'), query.get('toChain'), query.get('bridge')], ['0xabc', '42161', '8453', 'across'])
})

test('a same-chain swap’s status request names no bridge', async () => {
  const { query } = await statusOf({ status: 'PENDING' }, { tool: '1inch', fromChain: 42161, toChain: 42161 })
  assert.equal(query.has('bridge'), false)
})

test('a transfer LI.FI has not indexed yet is pending, with LI.FI’s answer as the detail', async () => {
  const { result } = await statusOf({ message: 'Not found' }, undefined, 404)
  assert.deepEqual(result, { state: 'pending', detail: 'li.quest responded 404: Not found' })
})

test('a pending transfer stays pending with LI.FI’s explanation', async () => {
  const { result } = await statusOf({ status: 'PENDING', substatus: 'WAIT_DESTINATION_TRANSACTION', substatusMessage: 'Waiting for the bridge' })
  assert.deepEqual(result, { state: 'pending', detail: 'Waiting for the bridge' })
})

test('a transfer LI.FI reports as not found is still pending', async () => {
  const { result } = await statusOf({ status: 'NOT_FOUND' })
  assert.equal(result.state, 'pending')
})

test('a failed transfer is failed, with the substatus when there is no message', async () => {
  const { result } = await statusOf({ status: 'FAILED', substatus: 'SLIPPAGE_EXCEEDED' })
  assert.deepEqual(result, { state: 'failed', detail: 'SLIPPAGE_EXCEEDED' })
})

test('an invalid transfer is failed', async () => {
  const { result } = await statusOf({ status: 'INVALID' })
  assert.equal(result.state, 'failed')
})

test('a transfer the bridge refunded is failed, although LI.FI calls it done', async () => {
  const { result } = await statusOf({ status: 'DONE', substatus: 'REFUNDED' })
  assert.deepEqual(result, { state: 'failed', detail: 'The bridge refunded the transfer to the sender' })
})

test('a completed transfer reports the exact amount received and the destination transaction', async () => {
  const { result } = await statusOf({ status: 'DONE', substatus: 'COMPLETED', receiving: { amount: '99812345', txHash: '0xdest' } })
  assert.deepEqual(result, { state: 'done', detail: 'COMPLETED', receivedAmount: 99812345n, destTxId: '0xdest' })
})

test('a completed transfer without receiving details is done, with the amount unknown', async () => {
  const { result } = await statusOf({ status: 'DONE' })
  assert.deepEqual(result, { state: 'done', detail: undefined, receivedAmount: undefined, destTxId: undefined })
})

test('a route from a chain LI.FI was not told about is built as an EVM transaction', async () => {
  const { fetchFn } = lifiApi({ '/v1/advanced/stepTransaction': step() })
  const [action] = await lifiProvider(fetchFn, [base], noBridgeSettings).buildActions!(normalizeLifiStep(step(), request()))
  assert.equal(action!.kind, 'evm-tx')
})
