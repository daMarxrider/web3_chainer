import { fetchJson } from './http.ts'
import { isNative } from './tokens.ts'
import type { Chain, FetchFn, Store, Token } from './types.ts'

/**
 * A curated token list, used to tell well-known tokens apart from look-alikes and scam coins.
 * Uniswap Labs' default list (the one its own interface uses), in the Token Lists format.
 * It is fetched at run time and cached for a day; it is not bundled with the app.
 */
export const TOKEN_LIST_URL = 'https://tokens.uniswap.org'
const CACHE_KEY = 'tokenlist.json'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** The list numbers Solana 501000101; LI.FI and this app use LI.FI's id. */
const LIST_CHAIN_IDS: Record<number, number> = { 501000101: 1151111081099710 }
/** A chain counts as covered by the list from this many tokens on; below it the list is too thin to judge by. */
const COVERED_FROM = 10

export interface ListedToken {
  chainId: number
  address: string
  symbol: string
  name: string
}
export interface TokenList {
  name: string
  fetchedAt: string
  tokens: ListedToken[]
}

/** EVM addresses compare without case; Solana's base58 addresses are case-sensitive. */
const addressKey = (address: string) => (address.startsWith('0x') ? address.toLowerCase() : address)

function parseList(raw: unknown): ListedToken[] {
  const tokens = (raw as { tokens?: unknown })?.tokens
  if (!Array.isArray(tokens)) throw new Error('The token list has no tokens')
  const out: ListedToken[] = []
  for (const t of tokens as Record<string, unknown>[]) {
    if (typeof t?.chainId !== 'number' || typeof t.address !== 'string' || typeof t.symbol !== 'string') continue
    out.push({ chainId: LIST_CHAIN_IDS[t.chainId] ?? t.chainId, address: t.address, symbol: t.symbol, name: typeof t.name === 'string' ? t.name : t.symbol })
  }
  if (out.length === 0) throw new Error('The token list has no usable tokens')
  return out
}

/** The cached list when it is less than a day old, otherwise a fresh one; a stale copy if the download fails. */
export async function loadTokenList(fetchFn: FetchFn, store: Store, now = Date.now()): Promise<TokenList | undefined> {
  const text = await store.get(CACHE_KEY)
  const cached = text ? (JSON.parse(text) as TokenList) : undefined
  if (cached && now - Date.parse(cached.fetchedAt) < MAX_AGE_MS) return cached
  try {
    const raw = await fetchJson<{ name?: string }>(fetchFn, TOKEN_LIST_URL)
    const list: TokenList = { name: raw.name ?? 'Uniswap default token list', fetchedAt: new Date(now).toISOString(), tokens: parseList(raw) }
    await store.set(CACHE_KEY, JSON.stringify(list))
    return list
  } catch {
    return cached
  }
}

/**
 * How far a token can be trusted, best first:
 * - listed: the chain's own coin, or on the curated list (on test networks every token that is not flagged);
 * - screened: not on the list, but LI.FI's token screening found nothing against it;
 * - unknown: neither;
 * - flagged: LI.FI's screening flagged it. Such tokens are not offered and not sent.
 */
export type TokenTrust = 'listed' | 'screened' | 'unknown' | 'flagged'

export class TokenIndex {
  private readonly byChain = new Map<number, Map<string, string>>()
  readonly list: TokenList | undefined
  constructor(list: TokenList | undefined) {
    this.list = list
    for (const t of list?.tokens ?? []) {
      let names = this.byChain.get(t.chainId)
      if (!names) this.byChain.set(t.chainId, (names = new Map()))
      names.set(addressKey(t.address), t.name)
    }
  }
  /** Whether the list says enough about a chain to judge its tokens by it. */
  covers(chain: Chain): boolean {
    return (this.byChain.get(chain.id)?.size ?? 0) >= COVERED_FROM
  }
  /** The token's name as the list gives it; the list's names are curated, LI.FI's are often just the symbol. */
  name(token: Token, chain: Chain): string | undefined {
    return this.byChain.get(chain.id)?.get(addressKey(token.address))
  }
  trust(token: Token, chain: Chain): TokenTrust {
    if (token.screening === 'flagged') return 'flagged'
    if (isNative(token) || chain.testnet) return 'listed'
    if (this.byChain.get(chain.id)?.has(addressKey(token.address))) return 'listed'
    return token.screening === 'verified' ? 'screened' : 'unknown'
  }
}

const RANK: Record<TokenTrust, number> = { listed: 0, screened: 1, unknown: 2, flagged: 3 }

/** Symbols that track a fiat currency, for grouping. */
export const STABLECOINS = new Set(['USDC', 'USDT', 'USDT0', 'DAI', 'USDS', 'USDE', 'PYUSD', 'FDUSD', 'RLUSD', 'GHO', 'FRAX', 'LUSD', 'CRVUSD', 'USDC.E', 'USDBC', 'EURC', 'EURE'])
/** What most people move, in the order offered: the chain's coin first, then ETH, BTC, SOL and stablecoins. */
const POPULAR = ['ETH', 'WETH', 'WBTC', 'CBBTC', 'TBTC', 'BTC.B', 'BTCB', 'LBTC', 'SOL', 'WSOL', 'USDC', 'USDT', 'USDT0', 'DAI', 'USDS', 'USDE', 'PYUSD', 'EURC']

const popularity = (t: Token) => {
  const i = POPULAR.indexOf(t.symbol.toUpperCase())
  return isNative(t) ? -1 : i < 0 ? POPULAR.length : i
}

export interface RatedToken {
  token: Token
  trust: TokenTrust
}

/** The chain's coin and the usual majors and stablecoins, one per symbol, only trusted ones. */
export function popularTokens(tokens: Token[], chain: Chain, index: TokenIndex): RatedToken[] {
  const strictly = index.covers(chain) ? ['listed'] : ['listed', 'screened']
  const out: RatedToken[] = []
  const seen = new Set<string>()
  const add = (token: Token) => {
    const trust = index.trust(token, chain)
    const symbol = token.symbol.toUpperCase()
    if (!strictly.includes(trust) || seen.has(symbol)) return
    seen.add(symbol)
    out.push({ token, trust })
  }
  for (const t of tokens) if (isNative(t)) add(t)
  for (const symbol of POPULAR) {
    const matches = tokens.filter((t) => t.symbol.toUpperCase() === symbol).sort((a, b) => RANK[index.trust(a, chain)] - RANK[index.trust(b, chain)])
    if (matches[0]) add(matches[0])
  }
  return out
}

/**
 * Tokens matching what the user typed (symbol, name or exact address), flagged ones left out.
 * Order: listed before screened before unknown (so a look-alike never sorts above the real token), then exact symbol, symbol prefix, symbol containing it, name.
 */
export function searchTokens(tokens: Token[], query: string, chain: Chain, index: TokenIndex, limit = 40): RatedToken[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: { rated: RatedToken; score: number }[] = []
  for (const token of tokens) {
    const trust = index.trust(token, chain)
    if (trust === 'flagged') continue
    const symbol = token.symbol.toLowerCase()
    const match = symbol === q || token.address.toLowerCase() === q ? 0 : symbol.startsWith(q) ? 1 : symbol.includes(q) ? 2 : (index.name(token, chain) ?? token.name ?? '').toLowerCase().includes(q) ? 3 : -1
    if (match < 0) continue
    scored.push({ rated: { token, trust }, score: RANK[trust] * 10 + match })
  }
  return scored
    .sort((a, b) => a.score - b.score || popularity(a.rated.token) - popularity(b.rated.token) || a.rated.token.symbol.localeCompare(b.rated.token.symbol))
    .slice(0, limit)
    .map((s) => s.rated)
}
