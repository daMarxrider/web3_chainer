/**
 * A fake world for running the real chainer command offline: the chains, tokens, balances and
 * routes that the fake network (preload.ts) answers with. Tests describe one per scenario.
 */
export interface WorldChain {
  key: string
  id: number
  name: string
  coin: string
  /** USD price of the chain's coin. */
  price?: number
  mainnet?: boolean
}
export interface WorldToken {
  chain: string
  symbol: string
  address: string
  decimals: number
  price?: number
  name?: string
  status?: 'verified' | 'flagged' | 'unverified'
}
export interface WorldRoute {
  /** "SYMBOL@chainKey" on both ends. */
  from: string
  to: string
  tool: string
  /** Share of the input that arrives, e.g. 0.99. */
  rate: number
  feeUsd?: number
  gasUsd?: number
  seconds?: number
}
export interface World {
  chains: WorldChain[]
  tokens: WorldToken[]
  /** address (any case) -> "chainKey:tokenAddress" (any case; the zero address for the coin) -> base units */
  balances?: Record<string, Record<string, string>>
  routes?: WorldRoute[]
  /** LI.FI status of every transfer; DONE by default. */
  status?: 'DONE' | 'PENDING' | 'FAILED'
  /** Base units LI.FI reports as received; unknown by default (the run then counts what it expected). */
  received?: string
  /** ERC-20 allowance every token already has for the bridge; 0 by default, so an approval is sent. */
  allowance?: string
  /** Outcome of every mined transaction. */
  receipt?: 'success' | 'reverted'
  /** Gas price in wei on every chain; 1 gwei by default. */
  gasPriceWei?: string
  /** The curated token list, or absent (then its download fails with 404). */
  tokenList?: { name: string; tokens: { chainId: number; address: string; symbol: string; name: string }[] }
  /** Tokens LI.FI finds when asked for them by address, but does not list for their chain. */
  unlisted?: WorldToken[]
  /** LI.FI answers every token list request with this error. */
  tokensError?: { status: number; message: string }
  /** LI.FI answers every route search with this error (e.g. a rate limit). */
  routesError?: { status: number; message: string }
}

export const ZERO = '0x0000000000000000000000000000000000000000'
export const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11'
/** Where LI.FI's fake transactions go and what it asks approvals for. */
export const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
export const rpcUrlOf = (key: string) => `https://rpc-${key}.fake`

/** One line of the fake network's log. */
export type LogLine = { kind: 'request'; url: string; method?: string } | { kind: 'broadcast'; chain: string; raw: string } | { kind: 'unexpected'; url: string; method?: string }
