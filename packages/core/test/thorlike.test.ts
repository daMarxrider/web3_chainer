import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeFunctionData, hexToString } from 'viem'
import { THORCHAIN, thorProvider, type Chain, type QuoteRequest, type Token } from '../src/index.ts'

const chains: Chain[] = [
  { family: 'evm', key: 'eth', id: 1, name: 'Ethereum', nativeSymbol: 'ETH', rpcUrls: [], testnet: false, nativePriceUsd: 2000 },
  { family: 'bitcoin', key: 'btc', id: 20000000000001, name: 'Bitcoin', nativeSymbol: 'BTC', rpcUrls: [], testnet: false, nativePriceUsd: 60000 },
  { family: 'solana', key: 'sol', id: 1151111081099710, name: 'Solana', nativeSymbol: 'SOL', rpcUrls: [], testnet: false, nativePriceUsd: 100 },
]
const ETH: Token = { chainKey: 'eth', address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 }
const USDC: Token = { chainKey: 'eth', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 }
const BTC: Token = { chainKey: 'btc', address: 'bitcoin', symbol: 'BTC', decimals: 8 }
const SOL: Token = { chainKey: 'sol', address: '11111111111111111111111111111111', symbol: 'SOL', decimals: 9 }
const VAULT = '0x0d15b57a5ba0a31a4774c03ddfacf79b289db9ce'
const ROUTER = '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146'
const BTC_VAULT = 'bc1qd5gsu875lekewcelhx6s7rskl0v3mw3d2yfn6l'
const SOL_VAULT = 'EmR9wBW3Zmk2dbGoHExDfPNM4d23tN6mZvDYHSSvB1RW'
const DEST = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'

/** A fake THORNode. `status` is what /tx/status answers. */
function fakeNode(status?: unknown) {
  const calls: string[] = []
  const fetchFn: typeof fetch = async (url) => {
    const u = new URL(String(url))
    calls.push(u.pathname + u.search)
    const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code })
    if (u.pathname.endsWith('/pools')) {
      return json(['ETH.ETH', 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', 'BTC.BTC', 'SOL.SOL'].map((asset) => ({ asset, status: 'Available' })))
    }
    if (u.pathname.endsWith('/inbound_addresses')) {
      const entry = (chain: string, address: string, router?: string, halted = false) => ({ chain, address, router, halted, gas_rate: '15', gas_rate_units: 'gwei' })
      return json([entry('ETH', VAULT, ROUTER), entry('BTC', BTC_VAULT), entry('SOL', SOL_VAULT)])
    }
    if (u.pathname.endsWith('/quote/swap')) {
      const to = u.searchParams.get('to_asset')
      const from = u.searchParams.get('from_asset')!
      const vault = from.startsWith('BTC') ? BTC_VAULT : from.startsWith('SOL') ? SOL_VAULT : VAULT
      return json({
        inbound_address: vault,
        router: from.startsWith('ETH') ? ROUTER : undefined,
        expiry: 4102444800,
        memo: `=:${to === 'BTC.BTC' ? 'b' : 'e'}:${u.searchParams.get('destination')}`,
        expected_amount_out: '1000000',
        recommended_min_amount_in: '1000',
        recommended_gas_rate: '15',
        gas_rate_units: from.startsWith('BTC') ? 'satsperbyte' : 'gwei',
        total_swap_seconds: 42,
        fees: { total: '1' },
      })
    }
    if (u.pathname.includes('/tx/status/')) return status ? json(status) : json({ message: 'not found' }, 404)
    return json({}, 404)
  }
  return { calls, fetchFn }
}

const request = (from: Token, to: Token, amount: bigint): QuoteRequest => ({ from, to, amount, fromAddress: 'me-from', toAddress: DEST, slippage: 0.01 })

test('quote converts 8-decimal amounts to the token and prices the deposit gas', async () => {
  const provider = thorProvider(fakeNode().fetchFn, THORCHAIN, chains)
  const [q] = await provider.getQuotes(request(ETH, BTC, 10n ** 18n), 'cheapest')
  assert.equal(q!.toAmount, 1_000_000n)
  assert.equal(q!.toAmountMin, 990_000n)
  assert.equal(q!.etaSeconds, 42)
  assert.ok(q!.costUsd > 0.5 && q!.costUsd < 5, `gas ${q!.costUsd}`)
})

test('a pair the network does not trade gives no quote', async () => {
  const provider = thorProvider(fakeNode().fetchFn, THORCHAIN, chains)
  assert.deepEqual(await provider.getQuotes(request(ETH, { ...USDC, chainKey: 'arb' }, 10n ** 18n), 'cheapest'), [])
})

test('an amount below the network minimum is reported', async () => {
  const provider = thorProvider(fakeNode().fetchFn, THORCHAIN, chains)
  await assert.rejects(provider.getQuotes(request(BTC, ETH, 500n), 'cheapest'), /below/)
})

test('ETH deposit: a plain send to the vault with the memo and the minimum payout in the data', async () => {
  const provider = thorProvider(fakeNode().fetchFn, THORCHAIN, chains)
  const [q] = await provider.getQuotes(request(ETH, BTC, 10n ** 18n), 'cheapest')
  const [a] = await provider.buildActions(q!)
  assert.equal(a!.kind, 'evm-tx')
  if (a!.kind !== 'evm-tx') return
  assert.equal(a.to, VAULT)
  assert.equal(a.value, 10n ** 18n)
  assert.equal(hexToString(a.data as `0x${string}`), `=:b:${DEST}:990000`)
})

test('token deposit: approve the router, then depositWithExpiry with the same memo', async () => {
  const provider = thorProvider(fakeNode().fetchFn, THORCHAIN, chains)
  const [q] = await provider.getQuotes(request(USDC, BTC, 100_000_000n), 'cheapest')
  const [a] = await provider.buildActions(q!)
  if (a!.kind !== 'evm-tx') throw new Error('wrong action')
  assert.equal(a.to, ROUTER)
  assert.deepEqual(a.approval, { token: USDC.address, spender: ROUTER, amount: 100_000_000n })
  const decoded = decodeFunctionData({
    abi: [{ type: 'function', name: 'depositWithExpiry', stateMutability: 'payable', inputs: [{ name: 'vault', type: 'address' }, { name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'memo', type: 'string' }, { name: 'expiration', type: 'uint256' }], outputs: [] }],
    data: a.data as `0x${string}`,
  })
  assert.equal(decoded.args[3], `=:b:${DEST}:990000`)
  assert.equal(String(decoded.args[0]).toLowerCase(), VAULT)
})

test('Bitcoin and Solana deposits go to their vaults with the memo', async () => {
  const provider = thorProvider(fakeNode().fetchFn, THORCHAIN, chains)
  const [qb] = await provider.getQuotes(request(BTC, ETH, 100_000n), 'cheapest')
  const [ab] = await provider.buildActions(qb!)
  assert.deepEqual(ab, { kind: 'utxo-send', chainKey: 'btc', to: BTC_VAULT, amount: 100_000n, memo: `=:e:${DEST}:990000` })
  const [qs] = await provider.getQuotes(request(SOL, BTC, 1_000_000_000n), 'cheapest')
  const [as] = await provider.buildActions(qs!)
  assert.equal(as!.kind, 'solana-transfer')
  if (as!.kind === 'solana-transfer') assert.equal(as.to, SOL_VAULT)
})

test('a halted chain stops the deposit', async () => {
  const node = fakeNode()
  const fetchFn: typeof fetch = async (url, init) => {
    const res = await node.fetchFn(url, init)
    if (!String(url).endsWith('/inbound_addresses')) return res
    const list = (await res.json()) as { halted: boolean }[]
    list.forEach((e) => (e.halted = true))
    return new Response(JSON.stringify(list))
  }
  const provider = thorProvider(fetchFn, THORCHAIN, chains)
  const [q] = await provider.getQuotes(request(ETH, BTC, 10n ** 18n), 'cheapest')
  await assert.rejects(provider.buildActions(q!), /paused deposits/)
})

test('status follows the swap to the payout', async () => {
  const stages = (extra: object) => ({ stages: { inbound_observed: { completed: true }, inbound_finalised: { completed: true }, swap_status: { pending: false }, swap_finalised: { completed: true }, ...extra } })
  const status = async (body?: unknown) => thorProvider(fakeNode(body).fetchFn, THORCHAIN, chains).getStatus('0xABCD'.padEnd(66, '0'), { toDecimals: 8 })

  assert.equal((await status()).state, 'pending')
  assert.match((await status(stages({ outbound_signed: { completed: false } }))).detail!, /payout/)
  const done = await status({ ...stages({ outbound_signed: { completed: true } }), out_txs: [{ id: 'OUTTX', coins: [{ asset: 'BTC.BTC', amount: '123456' }] }], planned_out_txs: [{ refund: false }] })
  assert.deepEqual([done.state, done.receivedAmount, done.destTxId], ['done', 123456n, 'OUTTX'])
  const refunded = await status({ ...stages({ outbound_signed: { completed: true } }), out_txs: [{ id: 'R', coins: [] }], planned_out_txs: [{ refund: true }] })
  assert.equal(refunded.state, 'failed')
})

test('a thin pool costs extra in the worst case and in the ranking, and a very thin one is refused', async () => {
  const withImpact = (bps: number): typeof fetch => async (url, init) => {
    const res = await fakeNode().fetchFn(url, init)
    if (!String(url).includes('/quote/swap')) return res
    const body = (await res.json()) as { fees: object }
    return new Response(JSON.stringify({ ...body, fees: { total: '1', slippage_bps: bps } }))
  }
  const priced = { ...BTC, priceUsd: 60000 }
  const deep = (await thorProvider(withImpact(10), THORCHAIN, chains).getQuotes(request(ETH, priced, 10n ** 18n), 'cheapest'))[0]!
  const thin = (await thorProvider(withImpact(1000), THORCHAIN, chains).getQuotes(request(ETH, priced, 10n ** 18n), 'cheapest'))[0]!
  assert.ok(thin.toAmountMin < deep.toAmountMin)
  assert.ok(thin.riskUsd! > deep.riskUsd!)
  await assert.rejects(thorProvider(withImpact(3000), THORCHAIN, chains).getQuotes(request(ETH, priced, 10n ** 18n), 'cheapest'), /too thin/)
})

test('a Dogecoin deposit asks for no refund address and a Bitcoin Cash destination loses its prefix', async () => {
  const quoteUrls: URLSearchParams[] = []
  const fetchFn: typeof fetch = async (url) => {
    const u = new URL(String(url))
    const json = (v: unknown) => new Response(JSON.stringify(v))
    if (u.pathname.endsWith('/pools')) return json(['DOGE.DOGE', 'BCH.BCH'].map((asset) => ({ asset, status: 'Available' })))
    if (u.pathname.endsWith('/inbound_addresses')) return json([{ chain: 'DOGE', address: 'DOGE_VAULT', halted: false }])
    quoteUrls.push(u.searchParams)
    return json({ inbound_address: 'DOGE_VAULT', expiry: 4102444800, memo: `=:c:${u.searchParams.get('destination')}`, expected_amount_out: '1000000', recommended_min_amount_in: '1000', fees: { total: '1' } })
  }
  const doge: Token = { chainKey: 'doge', address: 'dogecoin', symbol: 'DOGE', decimals: 8 }
  const bch: Token = { chainKey: 'bch', address: 'bitcoincash', symbol: 'BCH', decimals: 8 }
  const provider = thorProvider(fetchFn, THORCHAIN, [])
  const [q] = await provider.getQuotes({ from: doge, to: bch, amount: 2_000_000_000n, fromAddress: 'D-me', toAddress: 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6', slippage: 0.01 }, 'cheapest')
  const actions = await provider.buildActions(q!)
  assert.equal(quoteUrls[0]!.get('refund_address'), null)
  assert.equal(quoteUrls[0]!.get('destination'), 'qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6')
  assert.deepEqual(actions.map((a) => a.kind), ['utxo-send'])
  assert.equal((actions[0] as { to: string }).to, 'DOGE_VAULT')
})
