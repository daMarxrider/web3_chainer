import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultSettings,
  findPipelineRoutes,
  getTransfer,
  listPipelines,
  newPipeline,
  pipelineFromRoute,
  runPipeline,
  type BridgeProvider,
  type ChainAdapter,
  type PipelineDeps,
  type Quote,
  type QuoteRequest,
  type Signer,
  type Store,
  type Token,
} from '../src/index.ts'

function memoryStore(): Store {
  const data = new Map<string, string>()
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)) }
}

const token = (chainKey: string, symbol: string): Token => ({ chainKey, address: `0x${chainKey}${symbol}`, symbol, decimals: 6, priceUsd: 1 })
const A = token('a', 'AAA')
const HUB1 = token('h1', 'USDC')
const HUB2 = token('h2', 'USDC')
const Z = token('z', 'ZZZ')
const ME = '0xme'

/**
 * A fake bridge world: `links` lists which token pairs connect and what share of the input
 * arrives. It keeps wallet balances, so legs really have to fund each other.
 */
function world(links: [Token, Token, number][], start: [Token, bigint][]) {
  const balances = new Map<string, bigint>(start.map(([t, amount]) => [t.address, amount]))
  // Compared by address: records reloaded from the journal carry copies of the tokens.
  const rate = (from: Token, to: Token) => links.find(([f, t]) => f.address === from.address && t.address === to.address)?.[2]
  const sent: Quote[] = []
  let failNextSend = false
  let quoteCount = 0

  const provider: BridgeProvider = {
    name: 'fake',
    traits: { nonCustodial: true, needsApiKey: false },
    async getQuotes(request: QuoteRequest) {
      quoteCount++
      const r = rate(request.from, request.to)
      if (r === undefined) return []
      const toAmount = BigInt(Math.floor(Number(request.amount) * r))
      return [
        {
          provider: 'fake',
          tool: `${request.from.chainKey}-${request.to.chainKey}`,
          request,
          toAmount,
          toAmountMin: (toAmount * 99n) / 100n,
          toAmountUsd: Number(toAmount) / 1e6,
          costUsd: 0.1,
          etaSeconds: 30,
          viaSymbols: [request.from.symbol, request.to.symbol],
          raw: null,
          statusRef: { n: sent.length },
        },
      ]
    },
    buildActions: async (q) => [{ kind: 'evm-tx', chainKey: q.request.from.chainKey, to: '0x1', data: '0x', value: 0n }],
    async getStatus(_, ref) {
      const q = sent[Number(ref.n)]!
      return { state: 'done', receivedAmount: q.toAmount }
    },
  }

  let pending: Quote | undefined
  const adapterFor = (chainKey: string): ChainAdapter => ({
    chain: { family: 'evm', key: chainKey, id: 1, name: chainKey, nativeSymbol: 'ETH', rpcUrls: [], testnet: false },
    validateAddress: () => true,
    getBalances: async (_, tokens) => tokens.map((t) => balances.get(t.address) ?? 0n),
    prepare: async () => {},
    async send() {
      if (failNextSend) {
        failNextSend = false
        throw new Error('rpc down')
      }
      // The quote being executed is the most recent one for this chain.
      const q = pending!
      balances.set(q.request.from.address, (balances.get(q.request.from.address) ?? 0n) - q.request.amount)
      balances.set(q.request.to.address, (balances.get(q.request.to.address) ?? 0n) + q.toAmount)
      sent.push(q)
      return `0xtx${sent.length}`
    },
    waitForConfirmation: async () => true,
  })

  // Remember the quote the pipeline is about to execute, as a real provider's transaction would.
  const getQuotes = provider.getQuotes
  provider.getQuotes = async (request, prefer) => {
    const quotes = await getQuotes(request, prefer)
    if (quotes[0]) {
      quotes[0].statusRef = { n: sent.length }
      pending = quotes[0]
    }
    return quotes
  }

  const deps = (store: Store, events: string[] = []): PipelineDeps => ({
    store,
    providers: [provider],
    settings: defaultSettings,
    signer: {} as Signer,
    adapterFor,
    pollMs: 1,
    onEvent: (_, i, message) => events.push(`${i + 1}: ${message}`),
  })
  return { provider, deps, balances, sent, quotes: () => quoteCount, failNextSend: () => (failNextSend = true), setRate: (from: Token, to: Token, r: number) => (links.find(([f, t]) => f === from && t === to)![2] = r) }
}

const request: QuoteRequest = { from: A, to: Z, amount: 1_000_000n, fromAddress: ME, toAddress: '0xfriend', slippage: 0.005 }
const search = (w: ReturnType<typeof world>, hubs: Token[], maxHops = 3) =>
  findPipelineRoutes(request, [w.provider], defaultSettings, { prefer: 'cheapest', hubs: async () => hubs, maxHops })

test('a direct route is used when one exists, without asking for hubs', async () => {
  const w = world([[A, Z, 0.99]], [])
  let hubsAsked = false
  const { routes } = await findPipelineRoutes(request, [w.provider], defaultSettings, { prefer: 'cheapest', maxHops: 3, hubs: async () => ((hubsAsked = true), [HUB1]) })
  assert.equal(routes[0]!.legs.length, 1)
  assert.equal(hubsAsked, false)
})

test('with no direct connection the best two-leg route through a hub is found', async () => {
  const w = world(
    [
      [A, HUB1, 0.9],
      [HUB1, Z, 0.9],
      [A, HUB2, 0.99],
      [HUB2, Z, 0.99],
    ],
    [],
  )
  const { routes } = await search(w, [HUB1, HUB2])
  assert.deepEqual(routes.map((r) => r.legs.map((q) => q.tool).join('>')), ['a-h2>h2-z', 'a-h1>h1-z'])
  const [first, second] = routes[0]!.legs
  // Stop-over funds stay in the user's wallet; only the last leg pays the recipient.
  assert.equal(first!.request.toAddress, ME)
  assert.equal(second!.request.toAddress, '0xfriend')
  // The second leg is planned with the worst case of the first.
  assert.equal(second!.request.amount, first!.toAmountMin)
})

test('three legs are found when two are not enough, and the hop limit is respected', async () => {
  const links: [Token, Token, number][] = [
    [A, HUB1, 0.99],
    [HUB1, HUB2, 0.99],
    [HUB2, Z, 0.99],
  ]
  const three = await search(world(links, []), [HUB1, HUB2], 3)
  assert.deepEqual(three.routes.map((r) => r.legs.map((q) => q.tool).join('>')), ['a-h1>h1-h2>h2-z'])
  assert.equal((await search(world(links, []), [HUB1, HUB2], 2)).routes.length, 0)
  assert.equal((await search(world(links, []), [HUB1, HUB2], 1)).routes.length, 0)
})

test('avoided tokens are not used as stop-overs', async () => {
  const w = world(
    [
      [A, HUB1, 0.99],
      [HUB1, Z, 0.99],
    ],
    [],
  )
  const settings = { ...defaultSettings, avoidTokens: ['h1:0xh1USDC'] }
  const { routes } = await findPipelineRoutes(request, [w.provider], settings, { prefer: 'cheapest', hubs: async () => [HUB1], maxHops: 3 })
  assert.equal(routes.length, 0)
})

test('a multi-leg route runs unattended: each leg forwards what the previous one delivered', async () => {
  const w = world(
    [
      [A, HUB1, 0.99],
      [HUB1, Z, 0.99],
    ],
    [[A, 5_000_000n]],
  )
  const store = memoryStore()
  const events: string[] = []
  const { routes } = await search(w, [HUB1])
  const result = await runPipeline(pipelineFromRoute(routes[0]!, 'main'), w.deps(store, events))

  assert.equal(result.state, 'done')
  assert.deepEqual(result.legs.map((l) => [l.state, l.received]), [['done', '990000'], ['done', '980100']])
  assert.equal(w.balances.get(A.address), 4_000_000n)
  assert.equal(w.balances.get(HUB1.address), 0n)
  assert.equal(w.balances.get(Z.address), 980_100n)
  assert.ok(events.includes('1: Arrived') && events.includes('2: Arrived'))
  assert.equal((await listPipelines(store))[0]!.state, 'done')
  assert.equal((await getTransfer(store, result.legs[1]!.transferId!))!.state, 'done')
})

test('"all" sends the whole balance on the first leg and only the delivered amount afterwards', async () => {
  const w = world(
    [
      [A, HUB1, 1],
      [HUB1, Z, 1],
    ],
    [
      [A, 700n],
      [HUB1, 5000n],
    ],
  )
  const legs = [
    { from: A, to: HUB1, amount: 'all', toAddress: ME },
    { from: HUB1, to: Z, amount: 'all', toAddress: ME },
  ]
  const result = await runPipeline(newPipeline('main', ME, legs), w.deps(memoryStore()))
  assert.equal(result.state, 'done')
  assert.equal(w.balances.get(A.address), 0n)
  // The 5000 already held on the hub are not swept along.
  assert.equal(w.balances.get(HUB1.address), 5000n)
  assert.equal(w.balances.get(Z.address), 700n)
})

test('a leg stops before sending when the rate has fallen below the planned minimum', async () => {
  const w = world(
    [
      [A, HUB1, 0.99],
      [HUB1, Z, 0.99],
    ],
    [[A, 1_000_000n]],
  )
  const { routes } = await search(w, [HUB1])
  w.setRate(HUB1, Z, 0.5)
  const result = await runPipeline(pipelineFromRoute(routes[0]!, 'main'), w.deps(memoryStore()))
  assert.deepEqual(result.legs.map((l) => l.state), ['done', 'failed'])
  assert.match(result.legs[1]!.error!, /fell below/)
  // Leg 1's funds are safe on the hub; nothing was sent for leg 2.
  assert.equal(w.balances.get(HUB1.address), 990_000n)
  assert.equal(w.sent.length, 1)
})

test('a failed run resumes from the failed leg without repeating finished ones', async () => {
  const w = world(
    [
      [A, HUB1, 0.99],
      [HUB1, Z, 0.99],
    ],
    [[A, 1_000_000n]],
  )
  const store = memoryStore()
  const { routes } = await search(w, [HUB1])
  w.setRate(HUB1, Z, 0.5)
  const failed = await runPipeline(pipelineFromRoute(routes[0]!, 'main'), w.deps(store))
  assert.equal(failed.state, 'failed')

  w.setRate(HUB1, Z, 0.99)
  const resumed = await runPipeline((await listPipelines(store))[0]!, w.deps(store))
  assert.equal(resumed.state, 'done')
  assert.equal(w.sent.length, 2)
  assert.equal(w.balances.get(Z.address), 980_100n)
})

test('a leg interrupted while sending is never re-sent on resume', async () => {
  const w = world([[A, Z, 1]], [[A, 100n]])
  const store = memoryStore()
  const record = newPipeline('main', ME, [{ from: A, to: Z, amount: '100', toAddress: ME }])
  w.failNextSend()
  assert.equal((await runPipeline(record, w.deps(store))).state, 'failed')

  const again = await runPipeline((await listPipelines(store))[0]!, w.deps(store))
  assert.equal(again.state, 'failed')
  assert.match(again.legs[0]!.error!, /unclear whether the transaction went out/)
  assert.equal(w.sent.length, 0)
})

// ---- geo restrictions ---------------------------------------------------

const asAcross = (w: ReturnType<typeof world>): BridgeProvider => ({
  ...w.provider,
  name: 'lifi',
  getQuotes: async (r, p) => (await w.provider.getQuotes(r, p)).map((q) => ({ ...q, provider: 'lifi', tool: 'across' })),
})

test('a bridge with geo restrictions is not used unless the user confirmed their location', async () => {
  const w = world([[A, Z, 1]], [[A, 100n]])
  const deps = { ...w.deps(memoryStore()), providers: [asAcross(w)] }
  const result = await runPipeline(newPipeline('main', ME, [{ from: A, to: Z, amount: '100', toAddress: ME }]), deps)
  assert.equal(result.state, 'failed')
  assert.match(result.legs[0]!.error!, /geo restrictions/)
  assert.equal(w.sent.length, 0)
})

test('with the confirmation recorded the restricted bridge runs', async () => {
  const w = world([[A, Z, 1]], [[A, 100n]])
  const deps = { ...w.deps(memoryStore()), providers: [asAcross(w)] }
  const result = await runPipeline(newPipeline('main', ME, [{ from: A, to: Z, amount: '100', toAddress: ME }], ['across']), deps)
  assert.equal(result.state, 'done')
  assert.equal(w.sent.length, 1)
})

test('stop-over funds wait at the wallet\'s own address on the stop-over chain, and its leg sends from there', async () => {
  const w = world(
    [
      [A, HUB1, 0.99],
      [HUB1, Z, 0.99],
    ],
    [[A, 5_000_000n]],
  )
  const addresses: Record<string, string> = { a: 'evm-address', h1: 'bc1-address', z: 'sol-address' }
  const { routes } = await findPipelineRoutes({ ...request, fromAddress: 'evm-address', toAddress: 'sol-address' }, [w.provider], defaultSettings, {
    prefer: 'cheapest',
    hubs: async () => [HUB1],
    maxHops: 3,
    addressOn: (chainKey) => addresses[chainKey]!,
  })
  const [first, second] = routes[0]!.legs
  assert.deepEqual([first!.request.fromAddress, first!.request.toAddress], ['evm-address', 'bc1-address'])
  assert.deepEqual([second!.request.fromAddress, second!.request.toAddress], ['bc1-address', 'sol-address'])

  const record = pipelineFromRoute(routes[0]!, 'main')
  assert.deepEqual(record.legs.map((l) => l.fromAddress), ['evm-address', 'bc1-address'])
})

test('a leg that names a transit wallet is signed by that wallet, the others by the run wallet', async () => {
  const w = world(
    [
      [A, HUB1, 0.9],
      [HUB1, Z, 0.9],
    ],
    [[A, 5_000_000n]],
  )
  const { routes } = await search(w, [HUB1])
  const record = pipelineFromRoute(routes[0]!, 'main')
  record.legs[1]!.wallet = 'transit-h1-1'
  const mine = { id: 'main' } as unknown as Signer
  const transit = { id: 'transit' } as unknown as Signer
  const seen: unknown[] = []
  const base = w.deps(memoryStore())
  const deps: PipelineDeps = {
    ...base,
    signer: mine,
    signerFor: () => transit,
    adapterFor: (key) => {
      const adapter = base.adapterFor(key)
      const send = adapter.send.bind(adapter)
      adapter.send = async (action, signer) => (seen.push(signer), send(action, signer))
      return adapter
    },
  }
  const done = await runPipeline(record, deps)
  assert.equal(done.state, 'done')
  assert.deepEqual(seen, [mine, transit])

  const again = pipelineFromRoute(routes[0]!, 'main')
  again.legs[1]!.wallet = 'transit-h1-1'
  const noSigner = await runPipeline(again, { ...base, signer: mine }).catch((e: Error) => e)
  assert.match(String((noSigner as Error).message ?? (noSigner as { legs: { error: string }[] }).legs[1]!.error), /not available to this run/)
})

test('a leg only uses the route the user chose, even when a better one appears later', async () => {
  const w = world([[A, Z, 0.9]], [[A, 5_000_000n]])
  const { routes } = await search(w, [])
  const record = pipelineFromRoute(routes[0]!, 'main')
  assert.equal(record.legs[0]!.pin, 'fake/a-z')

  // The chosen bridge is gone when the leg is quoted again: nothing is sent, and no other route is substituted.
  record.legs[0]!.pin = 'fake/other-bridge'
  const done = await runPipeline(record, w.deps(memoryStore()))
  assert.equal(done.state, 'failed')
  assert.match(done.legs[0]!.error!, /no longer offered/)
  assert.equal(w.sent.length, 0)

  // Without a pin (a hand-written plan) the best route at the time is taken.
  const plan = newPipeline('main', ME, [{ from: A, to: Z, amount: '1000000', fromAddress: ME, toAddress: '0xfriend' }])
  assert.equal((await runPipeline(plan, w.deps(memoryStore()))).state, 'done')
})
