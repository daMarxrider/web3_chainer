import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultSettings,
  findPipelineRoutes,
  newPipeline,
  rankRoutes,
  routeNetUsd,
  runPipeline,
  type BridgeProvider,
  type ChainAdapter,
  type PipelineDeps,
  type Quote,
  type QuoteRequest,
  type Route,
  type Signer,
  type Store,
  type Token,
  type TransferRecord,
} from '../src/index.ts'

// ---- fixtures ----

function memoryStore(): Store {
  const data = new Map<string, string>()
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async (p) => [...data.keys()].filter((k) => k.startsWith(p)) }
}
const token = (chainKey: string, symbol: string, priceUsd?: number): Token => ({ chainKey, address: `0x${chainKey}${symbol}`, symbol, decimals: 6, priceUsd })
const A = token('a', 'AAA')
const Z = token('z', 'ZZZ')
const H1 = token('h1', 'USDC')
const H2 = token('h2', 'USDT')
const ME = '0xme'
const FRIEND = '0xfriend'
const request = (amount = 1_000_000n): QuoteRequest => ({ from: A, to: Z, amount, fromAddress: ME, toAddress: FRIEND, slippage: 0.005 })

/** A quote; the parts a test cares about are given, the rest are neutral. */
const quote = (from: Token, to: Token, toAmount: bigint, extra: Partial<Quote> = {}): Quote => ({ provider: 'fake', tool: `${from.chainKey}-${to.chainKey}`, request: { from, to, amount: 1n, fromAddress: ME, toAddress: ME, slippage: 0 }, toAmount, toAmountMin: toAmount, costUsd: 0, etaSeconds: 10, viaSymbols: [], raw: null, statusRef: {}, ...extra })
const route = (...legs: Quote[]): Route => ({ legs })

/** A provider answering from a table of links "from>to" -> rate, or with errors for pairs listed in `fails`. */
function linksProvider(links: Record<string, number>, opts: { fails?: Record<string, string>; name?: string; tool?: string } = {}) {
  const asked: QuoteRequest[] = []
  const p: BridgeProvider = {
    name: opts.name ?? 'fake',
    traits: { nonCustodial: true, needsApiKey: false },
    async getQuotes(r) {
      asked.push(r)
      const key = `${r.from.symbol}>${r.to.symbol}`
      if (opts.fails?.[key]) throw new Error(opts.fails[key])
      const rate = links[key]
      if (rate === undefined) return []
      return [{ ...quote(r.from, r.to, BigInt(Math.floor(Number(r.amount) * rate))), provider: opts.name ?? 'fake', tool: opts.tool ?? key, request: r }]
    },
    buildActions: async (q) => [{ kind: 'evm-tx', chainKey: q.request.from.chainKey, to: '0x1', data: '0x', value: 0n }],
    getStatus: async () => ({ state: 'done', receivedAmount: 1n }),
  }
  return { p, asked }
}
const search = (providers: BridgeProvider[], hubs: Token[], maxHops = 3, extra: { addressOn?: (k: string) => string; settings?: typeof defaultSettings } = {}) =>
  findPipelineRoutes(request(), providers, extra.settings ?? defaultSettings, { prefer: 'cheapest', hubs: async () => hubs, maxHops, addressOn: extra.addressOn })

// ---- ranking routes ----

test('the route with the higher net value ranks first', () => {
  const cheap = route(quote(A, Z, 10n, { toAmountUsd: 10, costUsd: 1 }))
  const dear = route(quote(A, Z, 10n, { toAmountUsd: 10, costUsd: 3 }))
  assert.deepEqual(rankRoutes([dear, cheap], 'cheapest'), [cheap, dear])
})

test('routes of unknown value rank by the amount that arrives', () => {
  const more = route(quote(A, Z, 12n))
  const less = route(quote(A, Z, 10n))
  assert.deepEqual(rankRoutes([less, more], 'cheapest'), [more, less])
})

test('routes of equal value rank the faster first', () => {
  const slow = route(quote(A, Z, 10n, { etaSeconds: 90 }))
  const fast = route(quote(A, Z, 10n, { etaSeconds: 30 }))
  assert.deepEqual(rankRoutes([slow, fast], 'cheapest'), [fast, slow])
})

test('a fastest search ranks by total time over all legs, then by value', () => {
  const twoQuick = route(quote(A, H1, 10n, { etaSeconds: 10 }), quote(H1, Z, 10n, { etaSeconds: 10 }))
  const oneSlow = route(quote(A, Z, 99n, { etaSeconds: 60 }))
  const twoQuickMore = route(quote(A, H1, 11n, { etaSeconds: 10 }), quote(H1, Z, 11n, { etaSeconds: 10 }))
  assert.deepEqual(rankRoutes([oneSlow, twoQuick, twoQuickMore], 'fastest'), [twoQuickMore, twoQuick, oneSlow])
})

test('a route’s net value takes off the cost and expected loss of every earlier leg', () => {
  // last leg nets $10 - $1 = $9; the first leg cost $0.50 and risked $0.25 -> $8.25
  assert.equal(routeNetUsd(route(quote(A, H1, 1n, { costUsd: 0.5, riskUsd: 0.25 }), quote(H1, Z, 1n, { toAmountUsd: 10, costUsd: 1 }))), 8.25)
})

test('a route whose last leg has no known value has no net value', () => {
  assert.equal(routeNetUsd(route(quote(A, Z, 1n))), undefined)
})

// ---- searching through stop-overs ----

test('with a hop limit of 1 no stop-over is searched, and the sources’ errors are kept', async () => {
  const { p, asked } = linksProvider({ 'AAA>USDC': 1, 'USDC>ZZZ': 1 }, { fails: { 'AAA>ZZZ': 'rate limited' } })
  const found = await search([p], [H1], 1)
  assert.deepEqual([found.routes, found.errors, asked.length], [[], ['fake: rate limited'], 1])
})

test('a hub that is the token sent or the token wanted is not used as a stop-over', async () => {
  const { p, asked } = linksProvider({})
  await search([p], [A, Z, H1])
  assert.deepEqual(asked.filter((r) => r.from === A).map((r) => r.to.symbol), ['ZZZ', 'USDC'])
})

test('a hub on the avoid list is not used as a stop-over', async () => {
  const { p, asked } = linksProvider({})
  await search([p], [H1, H2], 3, { settings: { ...defaultSettings, avoidTokens: ['USDT'] } })
  assert.equal(asked.some((r) => r.to.symbol === 'USDT'), false)
})

test('"no quotes" answers while searching stop-overs are not reported as problems', async () => {
  const { p } = linksProvider({}, { fails: { 'AAA>USDC': 'No available quotes for the requested transfer', 'AAA>USDT': 'li.quest responded 404: not found' } })
  assert.deepEqual((await search([p], [H1, H2])).errors, [])
})

test('real problems while searching stop-overs are reported when no route is found', async () => {
  const { p } = linksProvider({}, { fails: { 'AAA>USDC': 'rate limited' } })
  assert.deepEqual((await search([p], [H1])).errors, ['fake: rate limited'])
})

test('when a route is found, problems on other paths are not reported', async () => {
  const { p } = linksProvider({ 'AAA>USDC': 1, 'USDC>ZZZ': 1 }, { fails: { 'AAA>USDT': 'rate limited' } })
  assert.deepEqual((await search([p], [H1, H2])).errors, [])
})

test('a route through two stop-overs is found when nothing shorter connects', async () => {
  const { p } = linksProvider({ 'AAA>USDC': 1, 'USDC>USDT': 1, 'USDT>ZZZ': 1 })
  const [best] = (await search([p], [H1, H2])).routes
  assert.deepEqual(best!.legs.map((q) => q.request.to.symbol), ['USDC', 'USDT', 'ZZZ'])
})

test('a route never passes the same stop-over twice', async () => {
  // USDC -> USDT -> USDC would be a loop; after A -> USDC -> USDT, USDC is not tried again.
  const { p, asked } = linksProvider({ 'AAA>USDC': 1, 'USDC>USDT': 1, 'USDT>USDC': 1 })
  await search([p], [H1, H2], 4)
  assert.equal(asked.some((r) => r.from.symbol === 'USDT' && r.to.symbol === 'USDC'), false)
})

const H3 = token('h3', 'DAI')

test('of two ways into the same stop-over, only the one delivering more is kept', async () => {
  // Into DAI: via USDC 1 000 000 x 0.9 = 900 000, via USDT 500 000 x 0.5 = 250 000. Nothing connects in two legs.
  const { p } = linksProvider({ 'AAA>USDC': 1, 'AAA>USDT': 0.5, 'USDC>DAI': 0.9, 'USDT>DAI': 0.5, 'DAI>ZZZ': 1 })
  const routes = (await search([p], [H1, H2, H3], 3)).routes
  assert.deepEqual(routes.map((r) => [r.legs.map((q) => q.request.to.symbol).join('>'), r.legs.at(-1)!.toAmount]), [['USDC>DAI>ZZZ', 900_000n]])
})

test('stop-over funds wait at the wallet’s own address on that chain, and the last leg pays the recipient', async () => {
  const { p, asked } = linksProvider({ 'AAA>USDC': 1, 'USDC>ZZZ': 1 })
  await search([p], [H1], 3, { addressOn: (k) => `0xmine-on-${k}` })
  const intoHub = asked.find((r) => r.from.symbol === 'AAA' && r.to.symbol === 'USDC')!
  const outOfHub = asked.find((r) => r.from.symbol === 'USDC' && r.to.symbol === 'ZZZ')!
  assert.deepEqual([intoHub.fromAddress, intoHub.toAddress, outOfHub.fromAddress, outOfHub.toAddress], ['0xmine-on-a', '0xmine-on-h1', '0xmine-on-h1', FRIEND])
})

// ---- running legs ----

/** A fake chain where every send succeeds; balances by token address. */
function chainWorld(balances: Record<string, bigint>) {
  let sends = 0
  const adapter: ChainAdapter = {
    chain: { family: 'evm', key: 'a', id: 1, name: 'a', nativeSymbol: 'ETH', rpcUrls: [], testnet: false },
    validateAddress: () => true,
    getBalances: async (_a, tokens) => tokens.map((t) => balances[t.address] ?? 0n),
    prepare: async () => {},
    send: async () => `0xtx${++sends}`,
    waitForConfirmation: async () => true,
  }
  return { adapter, sends: () => sends }
}
const deps = (providers: BridgeProvider[], adapter: ChainAdapter, extra: Partial<PipelineDeps> = {}): PipelineDeps => ({ store: memoryStore(), providers, settings: defaultSettings, signer: {} as Signer, adapterFor: () => adapter, pollMs: 0, onEvent: () => {}, ...extra })
const oneLeg = (extra: Record<string, unknown> = {}) => newPipeline('main', ME, [{ from: A, to: Z, amount: '1000000', toAddress: FRIEND, ...extra }])
/** A journal entry for the transfer a leg had started before the app stopped. */
const started = async (store: Store, state: TransferRecord['state'], extra: Partial<TransferRecord> = {}) => {
  const t: TransferRecord = { id: 'prev', createdAt: '2026-11-26T00:00:00Z', wallet: 'main', provider: 'fake', tool: 'AAA>ZZZ', from: A, to: Z, amount: '1000000', expectedAmount: '990000', fromAddress: ME, toAddress: FRIEND, statusRef: {}, state, txId: '0xold', ...extra }
  await store.set('journal/prev.json', JSON.stringify(t))
}

test('a leg signed by a transit wallet that is not available stops with its name', async () => {
  const w = chainWorld({ [A.address]: 1_000_000n })
  const result = await runPipeline(oneLeg({ wallet: 'transit-a-1' }), deps([linksProvider({ 'AAA>ZZZ': 1 }).p], w.adapter))
  assert.equal(result.legs[0]!.error, 'This leg is signed by the wallet "transit-a-1", which is not available to this run')
})

test('a leg whose transfer was already done when the app stopped is finished without sending again', async () => {
  const w = chainWorld({ [A.address]: 1_000_000n })
  const d = deps([linksProvider({ 'AAA>ZZZ': 1 }).p], w.adapter)
  await started(d.store, 'done', { receivedAmount: '995000' })
  const result = await runPipeline(oneLeg({ transferId: 'prev' }), d)
  assert.deepEqual([result.legs[0]!.state, result.legs[0]!.received, w.sends()], ['done', '995000', 0])
})

test('a finished transfer without a received amount counts the amount it expected', async () => {
  const w = chainWorld({})
  const d = deps([linksProvider({}).p], w.adapter)
  await started(d.store, 'done')
  assert.equal((await runPipeline(oneLeg({ transferId: 'prev' }), d)).legs[0]!.received, '990000')
})

test('a leg that stopped while sending is not sent again, and says what to check', async () => {
  const w = chainWorld({ [A.address]: 1_000_000n })
  const d = deps([linksProvider({ 'AAA>ZZZ': 1 }).p], w.adapter)
  await started(d.store, 'signing')
  const result = await runPipeline(oneLeg({ transferId: 'prev' }), d)
  assert.deepEqual([result.legs[0]!.error, w.sends()], ['The app stopped while sending this leg, so it is unclear whether the transaction went out. Check the recent transactions of 0xme; it is not re-sent automatically.', 0])
})

test('a leg whose earlier attempt failed before anything was sent starts again', async () => {
  const w = chainWorld({ [A.address]: 1_000_000n })
  const d = deps([linksProvider({ 'AAA>ZZZ': 1 }).p], w.adapter)
  await started(d.store, 'failed', { txId: undefined })
  const result = await runPipeline(oneLeg({ transferId: 'prev' }), d)
  assert.deepEqual([result.legs[0]!.state, w.sends()], ['done', 1])
})

test('a leg whose transfer was submitted is followed to its end, not sent again', async () => {
  const w = chainWorld({})
  const d = deps([linksProvider({}).p], w.adapter)
  await started(d.store, 'submitted')
  const result = await runPipeline(oneLeg({ transferId: 'prev' }), d)
  assert.deepEqual([result.legs[0]!.state, w.sends()], ['done', 0])
})

test('a leg whose route source is no longer available says which one', async () => {
  const w = chainWorld({})
  const d = deps([linksProvider({}).p], w.adapter)
  await started(d.store, 'submitted', { provider: 'gone' })
  assert.equal((await runPipeline(oneLeg({ transferId: 'prev' }), d)).legs[0]!.error, 'Route source "gone" is not available')
})

test('a resumed swap that is still under way stops the leg and is never sent a second time', async () => {
  // The wallet still holds enough for the leg, so a second send would go through if it were tried.
  const w = chainWorld({ [A.address]: 1_000_000n })
  const p = { ...linksProvider({ 'AAA>ZZZ': 1 }).p, resume: async () => ({ state: 'pending' as const }) }
  const d = deps([p], w.adapter)
  await started(d.store, 'submitted', { providerState: { step: 'x' } })
  const result = await runPipeline(oneLeg({ transferId: 'prev' }), d)
  assert.deepEqual([result.legs[0]!.error, w.sends()], ["This leg's transfer is still under way (0xold); resume again later. It is not sent a second time.", 0])
})

test('a later leg forwarding "all" after a leg that recorded nothing sends nothing', async () => {
  const w = chainWorld({ [H1.address]: 5n })
  const record = newPipeline('main', ME, [{ from: A, to: H1, amount: '1', toAddress: ME }, { from: H1, to: Z, amount: 'all', toAddress: FRIEND }])
  record.legs[0]!.state = 'done' // done, but without a received amount
  const result = await runPipeline(record, deps([linksProvider({ 'USDC>ZZZ': 1 }).p], w.adapter))
  assert.equal(result.legs[1]!.error, 'Nothing to send: the wallet holds no USDC on h1')
})

test('a leg whose only routes need an unconfirmed location confirmation stops and says so', async () => {
  const w = chainWorld({ [A.address]: 1_000_000n })
  const restricted = linksProvider({ 'AAA>ZZZ': 1 }, { name: 'lifi', tool: 'across' }).p
  const result = await runPipeline(oneLeg(), deps([restricted], w.adapter))
  assert.deepEqual([result.legs[0]!.error, w.sends()], ['The only routes for this leg use bridges with geo restrictions that were not confirmed for this run', 0])
})

test('a leg may use a restricted bridge the user confirmed their location for', async () => {
  const w = chainWorld({ [A.address]: 1_000_000n })
  const restricted = linksProvider({ 'AAA>ZZZ': 1 }, { name: 'lifi', tool: 'across' }).p
  const result = await runPipeline(newPipeline('main', ME, [{ from: A, to: Z, amount: '1000000', toAddress: FRIEND }], ['across']), deps([restricted], w.adapter))
  assert.equal(result.legs[0]!.state, 'done')
})

test('a leg with no route names the sources’ problems', async () => {
  const w = chainWorld({ [A.address]: 1_000_000n })
  const result = await runPipeline(oneLeg(), deps([linksProvider({}, { fails: { 'AAA>ZZZ': 'rate limited' } }).p], w.adapter))
  assert.equal(result.legs[0]!.error, 'No route for this leg: fake: rate limited')
})

test('a leg with no route and no problems says only that', async () => {
  const w = chainWorld({ [A.address]: 1_000_000n })
  assert.equal((await runPipeline(oneLeg(), deps([linksProvider({}).p], w.adapter))).legs[0]!.error, 'No route for this leg')
})

test('a leg pinned to a route that is no longer offered stops instead of taking another', async () => {
  const w = chainWorld({ [A.address]: 1_000_000n })
  const result = await runPipeline(oneLeg({ pin: 'fake/old-bridge' }), deps([linksProvider({ 'AAA>ZZZ': 1 }).p], w.adapter))
  assert.deepEqual([result.legs[0]!.error, w.sends()], ['The route you chose (fake/old-bridge) is no longer offered for this leg, so nothing was sent. Choose a route again.', 0])
})

test('a leg pinned to a route that is still offered uses it', async () => {
  const w = chainWorld({ [A.address]: 1_000_000n })
  const result = await runPipeline(oneLeg({ pin: 'fake/AAA>ZZZ' }), deps([linksProvider({ 'AAA>ZZZ': 1 }).p], w.adapter))
  assert.equal(result.legs[0]!.via, 'fake/AAA>ZZZ')
})
