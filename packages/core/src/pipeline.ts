import { geoAllowed } from './geo.ts'
import { findRoutes, netUsd } from './optimizer.ts'
import { isAvoided, type Settings } from './settings.ts'
import { isNative } from './tokens.ts'
import { executeQuote, getTransfer, trackTransfer, type TransferRecord } from './transfer.ts'
import type { BridgeProvider, ChainAdapter, Prefer, Quote, QuoteRequest, Signer, Store, Token } from './types.ts'

// ---- multi-hop route search ---------------------------------------------

/** One or more quotes run in sequence; the output of each leg feeds the next. */
export interface Route {
  legs: Quote[]
}

const sameToken = (a: Token, b: Token) => a.chainKey === b.chainKey && a.address.toLowerCase() === b.address.toLowerCase()

/** USD value at the end of the route minus the gas and fees of every leg. */
export function routeNetUsd(route: Route): number | undefined {
  const last = netUsd(route.legs.at(-1)!)
  if (last === undefined) return undefined
  return last - route.legs.slice(0, -1).reduce((sum, q) => sum + q.costUsd + (q.riskUsd ?? 0), 0)
}
export const routeEta = (route: Route) => route.legs.reduce((sum, q) => sum + q.etaSeconds, 0)

export function rankRoutes(routes: Route[], prefer: Prefer): Route[] {
  const value = (a: Route, b: Route) => {
    const [na, nb] = [routeNetUsd(a), routeNetUsd(b)]
    if (na !== undefined && nb !== undefined && na !== nb) return nb - na
    const [ta, tb] = [a.legs.at(-1)!.toAmount, b.legs.at(-1)!.toAmount]
    return ta === tb ? 0 : ta > tb ? -1 : 1
  }
  const speed = (a: Route, b: Route) => routeEta(a) - routeEta(b)
  return [...routes].sort(prefer === 'fastest' ? (a, b) => speed(a, b) || value(a, b) : (a, b) => value(a, b) || speed(a, b))
}

export interface RouteSearchOptions {
  prefer: Prefer
  /** Liquid tokens to try as stop-overs; only asked for when there is no direct route. */
  hubs: () => Promise<Token[]>
  /** Most legs a route may have. */
  maxHops: number
  /** The wallet's own address on a chain, where stop-over funds wait. Defaults to the sender's address (all-EVM routes). */
  addressOn?: (chainKey: string) => string
}

/**
 * Finds routes from source to destination. Direct routes win when they exist; otherwise the
 * search goes through hub tokens, adding one stop-over per round until something connects
 * or the hop limit is reached. Each hub keeps only its best way in, so a round costs at most
 * one quote per hub pair.
 */
export async function findPipelineRoutes(
  request: QuoteRequest,
  providers: BridgeProvider[],
  settings: Settings,
  options: RouteSearchOptions,
): Promise<{ routes: Route[]; errors: string[] }> {
  const direct = await findRoutes(request, providers, settings, options.prefer)
  if (direct.quotes.length > 0 || options.maxHops < 2) return { routes: direct.quotes.map((q) => ({ legs: [q] })), errors: direct.errors }

  const hubs = (await options.hubs()).filter((h) => !isAvoided(settings, h) && !sameToken(h, request.from) && !sameToken(h, request.to))
  // Problems talking to a route source (rate limits, outages) are kept, so "no route" is not blamed on the chains.
  const errors = new Set(direct.errors)
  const best = async (r: QuoteRequest): Promise<Quote | undefined> => {
    const found = await findRoutes(r, providers, settings, options.prefer)
    for (const e of found.errors) if (!/No available quotes|404/.test(e)) errors.add(e)
    return found.quotes[0]
  }
  // Stop-over funds sit in the user's own wallet; the next leg spends the worst-case amount.
  const hop = (from: Token, to: Token, amount: bigint, final: boolean): QuoteRequest => ({
    ...request,
    from,
    to,
    amount,
    fromAddress: options.addressOn?.(from.chainKey) ?? request.fromAddress,
    toAddress: final ? request.toAddress : (options.addressOn?.(to.chainKey) ?? request.fromAddress),
  })

  let frontier: Route[] = []
  for (const q of await Promise.all(hubs.map((h) => best(hop(request.from, h, request.amount, false))))) if (q) frontier.push({ legs: [q] })

  for (let legs = 2; legs <= options.maxHops && frontier.length > 0; legs++) {
    const finals = await Promise.all(
      frontier.map(async (route) => {
        const last = route.legs.at(-1)!
        const q = await best(hop(last.request.to, request.to, last.toAmountMin, true))
        return q ? { legs: [...route.legs, q] } : undefined
      }),
    )
    const complete = finals.filter((r): r is Route => r !== undefined)
    if (complete.length > 0) return { routes: rankRoutes(complete, options.prefer), errors: [] }
    if (legs === options.maxHops) break

    // Nothing connects yet: extend every partial route by one more hub, keeping the best per hub.
    const next = new Map<Token, Route>()
    await Promise.all(
      frontier.flatMap((route) => {
        const last = route.legs.at(-1)!
        const visited = route.legs.map((q) => q.request.to)
        return hubs
          .filter((h) => !visited.some((v) => sameToken(v, h)))
          .map(async (h) => {
            const q = await best(hop(last.request.to, h, last.toAmountMin, false))
            if (q && q.toAmount > (next.get(h)?.legs.at(-1)!.toAmount ?? 0n)) next.set(h, { legs: [...route.legs, q] })
          })
      }),
    )
    frontier = [...next.values()]
  }
  return { routes: [], errors: [...errors] }
}

// ---- pipelines ----------------------------------------------------------

export interface PipelineLeg {
  from: Token
  to: Token
  /** Smallest units, or "all": the whole wallet balance for the first leg, otherwise what the previous leg delivered. */
  amount: string
  /** The wallet's address on the source chain. Absent in runs saved before other chain families existed: then the run's `fromAddress` applies. */
  fromAddress?: string
  toAddress: string
  /** Rate seen when the route was planned; the leg stops if a fresh quote is worse than this. */
  planned?: { amountIn: string; minOut: string }
  state: 'waiting' | 'running' | 'done' | 'failed'
  /** Journal id of the transfer carrying this leg. */
  transferId?: string
  via?: string
  received?: string
  error?: string
}

export interface PipelineRecord {
  id: string
  createdAt: string
  wallet: string
  /** Address on the first leg's chain; each leg may carry its own (see PipelineLeg.fromAddress). */
  fromAddress: string
  legs: PipelineLeg[]
  state: 'running' | 'done' | 'failed'
  /**
   * LI.FI bridge keys with geo restrictions that the user confirmed their location for (see geo.ts).
   * Bridges with restrictions that are not listed here are never used by this run.
   */
  geoAccepted?: string[]
}

const PREFIX = 'pipelines/'
const save = (store: Store, record: PipelineRecord) => store.set(`${PREFIX}${record.id}.json`, JSON.stringify(record, null, 2))

export async function listPipelines(store: Store): Promise<PipelineRecord[]> {
  const keys = await store.keys(PREFIX)
  const records = await Promise.all(keys.map(async (k) => JSON.parse((await store.get(k))!) as PipelineRecord))
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function newPipeline(wallet: string, fromAddress: string, legs: Omit<PipelineLeg, 'state'>[], geoAccepted: string[] = []): PipelineRecord {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), wallet, fromAddress, state: 'running', geoAccepted, legs: legs.map((l) => ({ ...l, state: 'waiting' })) }
}

/** Turns a searched route into a pipeline: the first amount is fixed, later legs forward what arrived. */
export function pipelineFromRoute(route: Route, wallet: string, geoAccepted: string[] = []): PipelineRecord {
  const first = route.legs[0]!.request
  return newPipeline(
    wallet,
    first.fromAddress,
    route.legs.map((q, i) => ({
      from: q.request.from,
      to: q.request.to,
      amount: i === 0 ? q.request.amount.toString() : 'all',
      fromAddress: q.request.fromAddress,
      toAddress: q.request.toAddress,
      planned: { amountIn: q.request.amount.toString(), minOut: q.toAmountMin.toString() },
    })),
    geoAccepted,
  )
}

export interface PipelineDeps {
  store: Store
  providers: BridgeProvider[]
  settings: Settings
  signer: Signer
  adapterFor(chainKey: string): ChainAdapter
  onEvent(record: PipelineRecord, legIndex: number, message: string): void
  pollMs?: number
}

const min = (a: bigint, b: bigint) => (a < b ? a : b)

async function runLeg(record: PipelineRecord, i: number, deps: PipelineDeps): Promise<void> {
  const { store, providers, settings, signer } = deps
  const leg = record.legs[i]!
  const adapter = deps.adapterFor(leg.from.chainKey)
  const say = (message: string) => deps.onEvent(record, i, message)
  const transferDeps = (providerName: string, id?: string) => {
    const provider = providers.find((p) => p.name === providerName)
    if (!provider) throw new Error(`Route source "${providerName}" is not available`)
    return { store, provider, adapter, signer, adapterFor: deps.adapterFor, pollMs: deps.pollMs, id, onEvent: (_: TransferRecord, message: string) => say(message) }
  }
  const finish = async (t: TransferRecord) => {
    if (t.state !== 'done') throw new Error(t.error ?? `The transfer ended as "${t.state}"`)
    leg.state = 'done'
    leg.received = t.receivedAmount ?? t.expectedAmount
    await save(store, record)
  }

  // Pick up a transfer that was already under way when the app last stopped.
  if (leg.transferId) {
    let t = await getTransfer(store, leg.transferId)
    if (t?.state === 'submitted') t = await trackTransfer(t, transferDeps(t.provider))
    if (t?.state === 'signing') {
      throw new Error(`The app stopped while sending this leg, so it is unclear whether the transaction went out. Check the recent transactions of ${t.fromAddress}; it is not re-sent automatically.`)
    }
    if (t?.state === 'done') return finish(t)
    // created / failed: nothing left the wallet, so the leg starts again below.
  }

  const fromAddress = leg.fromAddress ?? record.fromAddress
  const [balance] = await adapter.getBalances(fromAddress, [leg.from])
  let amount: bigint
  if (leg.amount !== 'all') amount = BigInt(leg.amount)
  else amount = i === 0 ? balance! : min(BigInt(record.legs[i - 1]!.received ?? '0'), balance!)
  if (amount <= 0n) throw new Error(`Nothing to send: the wallet holds no ${leg.from.symbol} on ${leg.from.chainKey}`)
  if (amount > balance!) throw new Error(`Not enough ${leg.from.symbol} on ${leg.from.chainKey} for this leg`)

  say('Looking for the best route')
  const quoteFor = async (a: bigint) => {
    const request: QuoteRequest = { from: leg.from, to: leg.to, amount: a, fromAddress, toAddress: leg.toAddress, slippage: settings.slippage }
    const found = await findRoutes(request, providers, settings)
    // Bridges with geo restrictions are only used if the user confirmed their location for them.
    const quotes = found.quotes.filter((q) => geoAllowed(q, record.geoAccepted))
    if (quotes.length === 0) {
      const skipped = found.quotes.length > 0
      throw new Error(skipped ? 'The only routes for this leg use bridges with geo restrictions that were not confirmed for this run' : `No route for this leg${found.errors.length ? `: ${found.errors.join('; ')}` : ''}`)
    }
    return quotes[0]!
  }
  let quote = await quoteFor(amount)

  // Sending a whole balance of the chain's own coin must leave enough behind to pay for gas.
  if (leg.amount === 'all' && isNative(leg.from) && leg.from.priceUsd) {
    const reserve = BigInt(Math.ceil(((quote.costUsd * 2) / leg.from.priceUsd) * 10 ** leg.from.decimals))
    if (reserve >= amount) throw new Error(`The ${leg.from.symbol} balance is too small to cover gas for this leg`)
    amount -= reserve
    quote = await quoteFor(amount)
  }

  if (leg.planned && quote.toAmount * BigInt(leg.planned.amountIn) < BigInt(leg.planned.minOut) * amount) {
    throw new Error('The rate for this leg fell below the minimum of the planned route; nothing was sent')
  }

  leg.transferId = crypto.randomUUID()
  leg.via = `${quote.provider}/${quote.tool}`
  leg.state = 'running'
  leg.error = undefined
  await save(store, record)
  await finish(await executeQuote(quote, record.wallet, signer, transferDeps(quote.provider, leg.transferId)))
}

/** Runs every unfinished leg in order. Safe to call again on a stopped or failed pipeline. */
export async function runPipeline(record: PipelineRecord, deps: PipelineDeps): Promise<PipelineRecord> {
  record.state = 'running'
  await save(deps.store, record)
  for (let i = 0; i < record.legs.length; i++) {
    const leg = record.legs[i]!
    if (leg.state === 'done') continue
    try {
      await runLeg(record, i, deps)
      deps.onEvent(record, i, 'Arrived')
    } catch (err) {
      leg.state = 'failed'
      leg.error = (err as Error).message
      record.state = 'failed'
      await save(deps.store, record)
      deps.onEvent(record, i, `Failed: ${leg.error}`)
      return record
    }
  }
  record.state = 'done'
  await save(deps.store, record)
  return record
}
