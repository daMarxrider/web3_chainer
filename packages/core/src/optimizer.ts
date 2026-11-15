import { isAvoided, isSymbolAvoided, type Settings } from './settings.ts'
import type { BridgeProvider, Chain, Prefer, Quote, QuoteRequest } from './types.ts'

/** Enforces the permissionless rule: custodial sources are never used. */
export function usableProviders(providers: BridgeProvider[]): BridgeProvider[] {
  return providers.filter((p) => p.traits.nonCustodial)
}

/** What the user ends up with in USD after paying gas and extra fees, if prices are known. */
export function netUsd(q: Quote): number | undefined {
  const price = q.request.to.priceUsd
  const received = q.toAmountUsd ?? (price === undefined ? undefined : (Number(q.toAmount) / 10 ** q.request.to.decimals) * price)
  return received === undefined ? undefined : received - q.costUsd - (q.riskUsd ?? 0)
}

export function rankQuotes(quotes: Quote[], prefer: Prefer): Quote[] {
  const byValue = (a: Quote, b: Quote) => {
    const [na, nb] = [netUsd(a), netUsd(b)]
    if (na !== undefined && nb !== undefined && na !== nb) return nb - na
    return a.toAmount === b.toAmount ? 0 : a.toAmount > b.toAmount ? -1 : 1
  }
  const bySpeed = (a: Quote, b: Quote) => a.etaSeconds - b.etaSeconds
  return [...quotes].sort(prefer === 'fastest' ? (a, b) => bySpeed(a, b) || byValue(a, b) : (a, b) => byValue(a, b) || bySpeed(a, b))
}

export interface RouteSearch {
  /** Best first. */
  quotes: Quote[]
  /** Providers that failed, so the user can see why a source is missing. */
  errors: string[]
}

/** Asks every provider for quotes in parallel, drops routes touching avoided tokens, ranks the rest. */
export async function findRoutes(request: QuoteRequest, providers: BridgeProvider[], settings: Settings, prefer: Prefer = settings.prefer): Promise<RouteSearch> {
  if (isAvoided(settings, request.to)) throw new Error(`${request.to.symbol} is on your list of tokens to avoid`)
  const active = usableProviders(providers)
  const results = await Promise.allSettled(active.map((p) => p.getQuotes(request, prefer)))
  const quotes: Quote[] = []
  const errors: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') quotes.push(...r.value)
    else errors.push(`${active[i]!.name}: ${(r.reason as Error).message}`)
  })
  const allowed = quotes.filter((q) => !q.viaSymbols.some((s) => isSymbolAvoided(settings, s)))
  return { quotes: rankQuotes(allowed, prefer), errors }
}

/** Finds a chain by key, id or name; a unique partial name also works ("arbitrum", "base"). */
export function findChain(chains: Chain[], query: string): Chain {
  const lower = query.toLowerCase()
  // Common names that differ from the official chain name.
  const q = ({ optimism: 'opt', bnb: 'bsc', matic: 'pol', xdai: 'dai' } as Record<string, string>)[lower] ?? lower
  const exact = chains.filter((c) => c.key === q || String(c.id) === q || c.name.toLowerCase() === q)
  if (exact.length === 1) return exact[0]!
  const mainnets = chains.filter((c) => !c.testnet && c.name.toLowerCase().includes(q))
  if (mainnets.length === 1) return mainnets[0]!
  const partial = chains.filter((c) => c.name.toLowerCase().includes(q))
  if (partial.length === 1) return partial[0]!
  if (partial.length > 1) throw new Error(`"${query}" matches several chains: ${partial.map((c) => `${c.name} (${c.key})`).join(', ')}`)
  throw new Error(`Unknown chain "${query}". Run "chainer chains" to list them.`)
}
