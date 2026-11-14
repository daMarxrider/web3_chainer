import { zeroAddress } from 'viem'
import { fetchJson } from '../http.ts'
import type { Settings } from '../settings.ts'
import type { BridgeProvider, Chain, FetchFn, Quote, QuoteRequest, Token, TransferStatus } from '../types.ts'

const API = 'https://li.quest/v1'

interface LifiToken {
  address: string
  chainId: number
  symbol: string
  decimals: number
  priceUSD?: string
}
interface LifiChain {
  key: string
  id: number
  name: string
  mainnet: boolean
  multicallAddress?: string
  nativeToken: LifiToken
  metamask: { rpcUrls: string[] }
}
interface LifiCost {
  amountUSD?: string
  included?: boolean
}
export interface LifiQuote {
  tool: string
  action: { fromToken: LifiToken; toToken: LifiToken; fromChainId: number; toChainId: number }
  estimate: {
    approvalAddress: string
    toAmount: string
    toAmountMin: string
    toAmountUSD?: string
    executionDuration: number
    feeCosts?: LifiCost[]
    gasCosts?: LifiCost[]
  }
  includedSteps?: { action: { fromToken: LifiToken; toToken: LifiToken } }[]
  transactionRequest?: { to: string; data: string; value?: string; gasLimit?: string }
}

const toToken = (t: LifiToken, chainKey: string): Token => ({
  chainKey,
  address: t.address,
  symbol: t.symbol,
  decimals: t.decimals,
  priceUsd: t.priceUSD ? Number(t.priceUSD) : undefined,
})

/** All EVM chains LI.FI can route, mainnets and testnets. */
export async function lifiChains(fetchFn: FetchFn): Promise<Chain[]> {
  const { chains } = await fetchJson<{ chains: LifiChain[] }>(fetchFn, `${API}/chains?chainTypes=EVM`)
  return chains.map((c) => ({
    family: 'evm',
    key: c.key,
    id: c.id,
    name: c.name,
    nativeSymbol: c.nativeToken.symbol,
    rpcUrls: c.metamask.rpcUrls,
    multicall: c.multicallAddress,
    testnet: !c.mainnet,
  }))
}

/** Looks a token up by symbol or contract address. */
export async function lifiToken(fetchFn: FetchFn, chain: Chain, symbolOrAddress: string): Promise<Token> {
  const t = await fetchJson<LifiToken>(fetchFn, `${API}/token?chain=${chain.id}&token=${encodeURIComponent(symbolOrAddress)}`)
  return toToken(t, chain.key)
}

/** Every token LI.FI can route on a chain. */
export async function lifiTokens(fetchFn: FetchFn, chain: Chain): Promise<Token[]> {
  const { tokens } = await fetchJson<{ tokens: Record<string, LifiToken[]> }>(fetchFn, `${API}/tokens?chains=${chain.id}`)
  return (tokens[chain.id] ?? []).map((t) => toToken(t, chain.key))
}

const sumUsd = (costs: LifiCost[] | undefined, filter: (c: LifiCost) => boolean) =>
  (costs ?? []).filter(filter).reduce((sum, c) => sum + Number(c.amountUSD ?? 0), 0)

/** Converts a LI.FI quote into the common Quote shape. Exported for tests. */
export function normalizeLifiQuote(q: LifiQuote, request: QuoteRequest): Quote {
  if (!q.transactionRequest) throw new Error('LI.FI quote has no transaction')
  const tx = q.transactionRequest
  const isNative = request.from.address.toLowerCase() === zeroAddress
  const via = new Set<string>()
  for (const step of q.includedSteps ?? []) {
    via.add(step.action.fromToken.symbol)
    via.add(step.action.toToken.symbol)
  }
  return {
    provider: 'lifi',
    tool: q.tool,
    request,
    toAmount: BigInt(q.estimate.toAmount),
    toAmountMin: BigInt(q.estimate.toAmountMin),
    toAmountUsd: q.estimate.toAmountUSD ? Number(q.estimate.toAmountUSD) : undefined,
    // Gas is always extra; fees marked "included" are already taken out of toAmount.
    costUsd: sumUsd(q.estimate.gasCosts, () => true) + sumUsd(q.estimate.feeCosts, (c) => c.included === false),
    etaSeconds: q.estimate.executionDuration,
    viaSymbols: [...via],
    actions: [
      {
        kind: 'evm-tx',
        chainKey: request.from.chainKey,
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value ?? 0),
        gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
        approval: isNative ? undefined : { token: request.from.address, spender: q.estimate.approvalAddress, amount: request.amount },
      },
    ],
    statusRef: { tool: q.tool, fromChain: q.action.fromChainId, toChain: q.action.toChainId },
  }
}

interface LifiStatus {
  status: 'NOT_FOUND' | 'INVALID' | 'PENDING' | 'DONE' | 'FAILED'
  substatus?: string
  substatusMessage?: string
  receiving?: { amount?: string; txHash?: string }
}

export function lifiProvider(fetchFn: FetchFn, chains: Chain[], settings: Pick<Settings, 'lifi'>): BridgeProvider {
  const chainId = (key: string) => {
    const chain = chains.find((c) => c.key === key)
    if (!chain) throw new Error(`LI.FI does not know chain "${key}"`)
    return chain.id
  }

  return {
    name: 'lifi',
    traits: { nonCustodial: true, needsApiKey: false },

    async getQuotes(request) {
      const params = new URLSearchParams({
        fromChain: String(chainId(request.from.chainKey)),
        toChain: String(chainId(request.to.chainKey)),
        fromToken: request.from.address,
        toToken: request.to.address,
        fromAmount: request.amount.toString(),
        fromAddress: request.fromAddress,
        toAddress: request.toAddress,
        slippage: String(request.slippage),
      })
      for (const b of settings.lifi.allowBridges) params.append('allowBridges', b)
      for (const b of settings.lifi.denyBridges) params.append('denyBridges', b)

      // LI.FI returns one quote per call; ask for its cheapest and its fastest.
      const results = await Promise.allSettled(
        ['CHEAPEST', 'FASTEST'].map((order) => fetchJson<LifiQuote>(fetchFn, `${API}/quote?${params}&order=${order}`)),
      )
      const quotes: Quote[] = []
      const seen = new Set<string>()
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        // Both orders often pick the same bridge; keep it once.
        const quote = normalizeLifiQuote(r.value, request)
        if (!seen.has(quote.tool)) quotes.push(quote)
        seen.add(quote.tool)
      }
      const failure = results.find((r) => r.status === 'rejected')
      if (quotes.length === 0 && failure) throw failure.reason
      return quotes
    },

    async getStatus(txId, ref): Promise<TransferStatus> {
      const params = new URLSearchParams({ txHash: txId, fromChain: String(ref.fromChain), toChain: String(ref.toChain) })
      if (ref.fromChain !== ref.toChain) params.set('bridge', String(ref.tool))
      let s: LifiStatus
      try {
        s = await fetchJson<LifiStatus>(fetchFn, `${API}/status?${params}`)
      } catch (err) {
        // Right after broadcast LI.FI may not have indexed the transaction yet.
        return { state: 'pending', detail: (err as Error).message }
      }
      const detail = s.substatusMessage ?? s.substatus
      if (s.status === 'FAILED' || s.status === 'INVALID') return { state: 'failed', detail }
      if (s.status !== 'DONE') return { state: 'pending', detail }
      if (s.substatus === 'REFUNDED') return { state: 'failed', detail: 'The bridge refunded the transfer to the sender' }
      return {
        state: 'done',
        detail,
        receivedAmount: s.receiving?.amount ? BigInt(s.receiving.amount) : undefined,
        destTxId: s.receiving?.txHash,
      }
    },
  }
}
