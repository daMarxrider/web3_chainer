import { zeroAddress } from 'viem'
import { fetchJson } from '../http.ts'
import type { Settings } from '../settings.ts'
import type { Action, BridgeProvider, Chain, FetchFn, Quote, QuoteRequest, Token, TransferStatus } from '../types.ts'

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
/** One step of a LI.FI route: a single transaction on the source chain. */
export interface LifiStep {
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

/** Converts a LI.FI step into the common Quote shape. Exported for tests. */
export function normalizeLifiStep(step: LifiStep, request: QuoteRequest): Quote {
  const via = new Set<string>()
  for (const part of step.includedSteps ?? []) {
    via.add(part.action.fromToken.symbol)
    via.add(part.action.toToken.symbol)
  }
  return {
    provider: 'lifi',
    tool: step.tool,
    request,
    toAmount: BigInt(step.estimate.toAmount),
    toAmountMin: BigInt(step.estimate.toAmountMin),
    toAmountUsd: step.estimate.toAmountUSD ? Number(step.estimate.toAmountUSD) : undefined,
    // Gas is always extra; fees marked "included" are already taken out of toAmount.
    costUsd: sumUsd(step.estimate.gasCosts, () => true) + sumUsd(step.estimate.feeCosts, (c) => c.included === false),
    etaSeconds: step.estimate.executionDuration,
    viaSymbols: [...via],
    raw: step,
    statusRef: { tool: step.tool, fromChain: step.action.fromChainId, toChain: step.action.toChainId },
  }
}

/** Builds the transaction to sign from a step that LI.FI has filled in with transaction data. Exported for tests. */
export function lifiAction(step: LifiStep, request: QuoteRequest): Action {
  const tx = step.transactionRequest
  if (!tx) throw new Error('LI.FI returned no transaction for this route')
  const isNative = request.from.address.toLowerCase() === zeroAddress
  return {
    kind: 'evm-tx',
    chainKey: request.from.chainKey,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value ?? 0),
    gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
    approval: isNative ? undefined : { token: request.from.address, spender: step.estimate.approvalAddress, amount: request.amount },
  }
}

interface LifiStatus {
  status: 'NOT_FOUND' | 'INVALID' | 'PENDING' | 'DONE' | 'FAILED'
  substatus?: string
  substatusMessage?: string
  receiving?: { amount?: string; txHash?: string }
}

const postJson = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export function lifiProvider(fetchFn: FetchFn, chains: Chain[], settings: Pick<Settings, 'lifi'>): BridgeProvider {
  const chainId = (key: string) => {
    const chain = chains.find((c) => c.key === key)
    if (!chain) throw new Error(`LI.FI does not know chain "${key}"`)
    return chain.id
  }

  return {
    name: 'lifi',
    traits: { nonCustodial: true, needsApiKey: false },

    // One request returns every bridge LI.FI can use for the pair, which keeps well inside its
    // limit of 75 route searches per two hours.
    async getQuotes(request, prefer) {
      const { allowBridges, denyBridges } = settings.lifi
      const { routes } = await fetchJson<{ routes: { steps: LifiStep[] }[] }>(
        fetchFn,
        `${API}/advanced/routes`,
        postJson({
          fromChainId: chainId(request.from.chainKey),
          toChainId: chainId(request.to.chainKey),
          fromTokenAddress: request.from.address,
          toTokenAddress: request.to.address,
          fromAmount: request.amount.toString(),
          fromAddress: request.fromAddress,
          toAddress: request.toAddress,
          options: {
            slippage: request.slippage,
            order: prefer === 'fastest' ? 'FASTEST' : 'CHEAPEST',
            // Only routes that are a single transaction on the source chain.
            allowSwitchChain: false,
            bridges: { allow: allowBridges.length ? allowBridges : undefined, deny: denyBridges.length ? denyBridges : undefined },
          },
        }),
      )
      return routes.filter((r) => r.steps.length === 1).map((r) => normalizeLifiStep(r.steps[0]!, request))
    },

    async buildActions(quote) {
      const step = await fetchJson<LifiStep>(fetchFn, `${API}/advanced/stepTransaction`, postJson(quote.raw))
      return [lifiAction(step, quote.request)]
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
