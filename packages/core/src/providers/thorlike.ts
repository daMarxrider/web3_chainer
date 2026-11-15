import { encodeFunctionData, stringToHex, type Address } from 'viem'
import { fetchJson } from '../http.ts'
import { isNative } from '../tokens.ts'
import type { Action, BridgeProvider, Chain, FetchFn, Quote, QuoteRequest, Token, TransferStatus } from '../types.ts'

/** What differs between THORChain and Maya Protocol, which share one node API. */
export interface ThorConfig {
  name: 'thorchain' | 'maya'
  /** Node API root, ending in the module name ("…/thorchain"). */
  api: string
  /** LI.FI chain key -> the network's chain code. */
  chainCodes: Record<string, string>
  /** LI.FI chain key -> the native asset on that chain. */
  nativeAssets: Record<string, string>
}

// Public node run for public use (THORChain developer docs name this gateway); no key, 50 000 requests per day per IP.
export const THORCHAIN: ThorConfig = {
  name: 'thorchain',
  api: 'https://gateway.liquify.com/chain/thorchain_api/thorchain',
  chainCodes: { eth: 'ETH', bas: 'BASE', ava: 'AVAX', bsc: 'BSC', btc: 'BTC', ltc: 'LTC', sol: 'SOL' },
  nativeAssets: { eth: 'ETH.ETH', bas: 'BASE.ETH', ava: 'AVAX.AVAX', bsc: 'BSC.BNB', btc: 'BTC.BTC', ltc: 'LTC.LTC', sol: 'SOL.SOL' },
}
export const MAYA: ThorConfig = {
  name: 'maya',
  api: 'https://mayanode.mayachain.info/mayachain',
  chainCodes: { eth: 'ETH', arb: 'ARB', btc: 'BTC' },
  nativeAssets: { eth: 'ETH.ETH', arb: 'ARB.ETH', btc: 'BTC.BTC' },
}

/** Quotes whose own price impact exceeds this are not offered at all. */
const MAX_IMPACT_BPS = 1500

/** Both networks count every asset with 8 decimals. */
const NORMAL = 8
const rescale = (amount: bigint, from: number, to: number) => (to >= from ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to))

interface NodeQuote {
  inbound_address?: string
  router?: string
  expiry: number
  memo: string
  expected_amount_out: string
  recommended_min_amount_in?: string
  recommended_gas_rate?: string
  gas_rate_units?: string
  total_swap_seconds?: number
  inbound_confirmation_seconds?: number
  outbound_delay_seconds?: number
  fees: { total: string; slippage_bps?: number }
}
interface Inbound {
  chain: string
  address: string
  router?: string
  halted: boolean
  chain_trading_paused?: boolean
  global_trading_paused?: boolean
}
interface TxStatus {
  planned_out_txs?: { refund: boolean }[]
  out_txs?: { id: string; coins: { asset: string; amount: string }[] }[]
  stages: {
    inbound_observed?: { completed: boolean }
    inbound_finalised?: { completed: boolean }
    swap_status?: { pending: boolean }
    swap_finalised?: { completed: boolean }
    outbound_signed?: { completed: boolean }
  }
}

const routerAbi = [
  {
    type: 'function',
    name: 'depositWithExpiry',
    stateMutability: 'payable',
    inputs: [
      { name: 'vault', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'memo', type: 'string' },
      { name: 'expiration', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

/** Wei (or smallest unit) per gas unit for the rate units the nodes report. */
const GAS_UNIT: Record<string, number> = { gwei: 1e9, nAVAX: 1e9, mwei: 1e6, centigwei: 1e7, satsperbyte: 1, lamport: 1 }

/** Rough cost of the deposit transaction in USD; 0 when the coin's price or the rate is unknown. */
function depositGasUsd(chain: Chain | undefined, family: Chain['family'], native: boolean, q: NodeQuote): number {
  const price = chain?.nativePriceUsd
  const unit = q.gas_rate_units ? GAS_UNIT[q.gas_rate_units] : undefined
  if (!price || !unit || !q.recommended_gas_rate) return 0
  const rate = Number(q.recommended_gas_rate)
  if (family === 'bitcoin') return ((rate * 220) / 1e8) * price
  if (family === 'solana') return ((rate * unit) / 1e9) * price
  return ((rate * unit * (native ? 45_000 : 110_000)) / 1e18) * price
}

export function thorProvider(fetchFn: FetchFn, config: ThorConfig, chains: Chain[] = []): BridgeProvider {
  let poolCache: { at: number; assets: string[] } | undefined
  const pools = async () => {
    if (poolCache && Date.now() - poolCache.at < 5 * 60_000) return poolCache.assets
    const list = await fetchJson<{ asset: string; status: string }[]>(fetchFn, `${config.api}/pools`)
    poolCache = { at: Date.now(), assets: list.filter((p) => p.status === 'Available').map((p) => p.asset) }
    return poolCache.assets
  }

  /** The network's name for a token, or undefined if it does not trade here. */
  const assetOf = (token: Token, available: string[]): string | undefined => {
    const code = config.chainCodes[token.chainKey]
    if (!code) return undefined
    if (isNative(token)) {
      const native = config.nativeAssets[token.chainKey]
      return native && available.includes(native) ? native : undefined
    }
    return available.find((a) => a.startsWith(`${code}.`) && a.split('-')[1]?.toLowerCase() === token.address.toLowerCase())
  }

  async function nodeQuote(request: QuoteRequest, fromAsset: string, toAsset: string): Promise<NodeQuote> {
    const params = new URLSearchParams({
      from_asset: fromAsset,
      to_asset: toAsset,
      amount: rescale(request.amount, request.from.decimals, NORMAL).toString(),
      destination: request.toAddress,
      refund_address: request.fromAddress,
    })
    return fetchJson<NodeQuote>(fetchFn, `${config.api}/quote/swap?${params}`)
  }

  const outAmount = (q: NodeQuote, to: Token) => {
    // The node answers without an amount when the swap would pay out less than the outbound fee.
    if (!q.expected_amount_out) throw new Error('This amount is too small to swap: the payout would not cover the network fee')
    return rescale(BigInt(q.expected_amount_out), NORMAL, to.decimals)
  }

  /**
   * Adds the minimum payout to the memo, so the network refunds the deposit instead of paying
   * less. The node's own tolerance parameter is not used: it rejects small tolerances that
   * are fine in practice.
   */
  const memoWithLimit = (memo: string, minOut: bigint, to: Token) => {
    const parts = memo.split(':')
    if (parts.length !== 3) throw new Error(`Unexpected ${config.name} memo "${memo}"; refusing to send`)
    return `${memo}:${rescale(minOut, to.decimals, NORMAL)}`
  }

  return {
    name: config.name,
    traits: { nonCustodial: true, needsApiKey: false },

    async getQuotes(request) {
      const available = await pools()
      const [fromAsset, toAsset] = [assetOf(request.from, available), assetOf(request.to, available)]
      if (!fromAsset || !toAsset || fromAsset === toAsset) return []

      let q: NodeQuote
      try {
        q = await nodeQuote(request, fromAsset, toAsset)
      } catch (err) {
        // Bitcoin-family deposits carry the memo in a data output of at most 80 bytes; long destination addresses do not fit.
        if (/memo too long/.test((err as Error).message)) return []
        throw err
      }
      const normalised = rescale(request.amount, request.from.decimals, NORMAL)
      if (q.recommended_min_amount_in && normalised < BigInt(q.recommended_min_amount_in)) {
        throw new Error(`${request.amount} is below the ${config.name} minimum for this swap; amounts this small are usually lost to fees`)
      }
      const toAmount = outAmount(q, request.to)
      // Thin pools: the price impact of the swap itself is already in the quote, but a pool that moves
      // this much between quote and settlement can move further. A tenth of the impact is added to the
      // worst case and counted as expected loss, so deep pools win over shallow ones at similar quotes.
      const impactBps = q.fees.slippage_bps ?? 0
      if (impactBps > MAX_IMPACT_BPS) throw new Error(`The ${config.name} pool is too thin for this amount (${(impactBps / 100).toFixed(1)} % price impact)`)
      const riskBps = Math.ceil(impactBps / 10)
      const bps = BigInt(Math.round(request.slippage * 10_000) + riskBps)
      const outUsd = request.to.priceUsd === undefined ? 0 : (Number(toAmount) / 10 ** request.to.decimals) * request.to.priceUsd
      return [
        {
          provider: config.name,
          tool: config.name,
          request,
          toAmount,
          toAmountMin: (toAmount * (10_000n - bps)) / 10_000n,
          // Pool and outbound fees are already taken from the output; this is the fee for the deposit transaction itself.
          riskUsd: (outUsd * riskBps) / 10_000,
          costUsd: depositGasUsd(chains.find((c) => c.key === request.from.chainKey), chains.find((c) => c.key === request.from.chainKey)?.family ?? 'evm', isNative(request.from), q),
          etaSeconds: q.total_swap_seconds ?? (q.inbound_confirmation_seconds ?? 0) + (q.outbound_delay_seconds ?? 0) + 6,
          viaSymbols: [request.from.symbol, request.to.symbol],
          raw: { fromAsset, toAsset },
          statusRef: { toDecimals: request.to.decimals },
        } satisfies Quote,
      ]
    },

    async buildActions(quote): Promise<Action[]> {
      const { request } = quote
      const { fromAsset, toAsset } = quote.raw as { fromAsset: string; toAsset: string }
      // Vault addresses change and quotes expire after about ten minutes, so ask again right before sending.
      const q = await nodeQuote(request, fromAsset, toAsset)
      if (outAmount(q, request.to) < quote.toAmountMin) throw new Error(`The ${config.name} rate moved below your minimum since the quote; nothing was sent`)

      const code = config.chainCodes[request.from.chainKey]!
      const inbound = (await fetchJson<Inbound[]>(fetchFn, `${config.api}/inbound_addresses`)).find((i) => i.chain === code)
      if (!inbound || inbound.halted || inbound.chain_trading_paused || inbound.global_trading_paused) throw new Error(`${config.name} has paused deposits on ${code}`)
      if (!q.inbound_address || q.inbound_address !== inbound.address) throw new Error(`${config.name} returned inconsistent deposit addresses; refusing to send`)

      const memo = memoWithLimit(q.memo, quote.toAmountMin, request.to)
      const chainKey = request.from.chainKey
      const vault = inbound.address
      const native = isNative(request.from)
      if (chainKey === 'btc' || chainKey === 'ltc') return [{ kind: 'utxo-send', chainKey, to: vault, amount: request.amount, memo }]
      if (chainKey === 'sol') return [{ kind: 'solana-transfer', chainKey, to: vault, amount: request.amount, mint: native ? undefined : request.from.address, memo }]
      if (native) return [{ kind: 'evm-tx', chainKey, to: vault, data: stringToHex(memo), value: request.amount }]

      if (!inbound.router) throw new Error(`${config.name} lists no router for ${code}`)
      const data = encodeFunctionData({
        abi: routerAbi,
        functionName: 'depositWithExpiry',
        args: [vault as Address, request.from.address as Address, request.amount, memo, BigInt(Math.floor(Date.now() / 1000) + 3600)],
      })
      return [{ kind: 'evm-tx', chainKey, to: inbound.router, data, value: 0n, approval: { token: request.from.address, spender: inbound.router, amount: request.amount } }]
    },

    async getStatus(txId, ref): Promise<TransferStatus> {
      const id = txId.replace(/^0x/i, '').toUpperCase()
      let s: TxStatus
      try {
        s = await fetchJson<TxStatus>(fetchFn, `${config.api}/tx/status/${/^[0-9A-F]{64}$/.test(id) ? id : txId}`)
      } catch (err) {
        // The network has not seen the deposit yet, or the node is busy.
        return { state: 'pending', detail: 'Waiting for the network to see the deposit' }
      }
      const { stages } = s
      if (!stages.inbound_observed?.completed) return { state: 'pending', detail: 'Waiting for the network to see the deposit' }
      if (!stages.inbound_finalised?.completed) return { state: 'pending', detail: 'Deposit seen, waiting for confirmations' }
      if (stages.swap_status?.pending || !stages.swap_finalised?.completed) return { state: 'pending', detail: 'Swapping' }
      const out = s.out_txs?.[0]
      const finished = stages.outbound_signed ? stages.outbound_signed.completed : !!out
      if (!finished) return { state: 'pending', detail: 'Swap done, sending the payout' }
      if (s.planned_out_txs?.some((p) => p.refund)) return { state: 'failed', detail: `${config.name} refunded the deposit to the sender` }
      return {
        state: 'done',
        receivedAmount: out?.coins[0] ? rescale(BigInt(out.coins[0].amount), NORMAL, Number(ref.toDecimals)) : undefined,
        destTxId: out?.id,
      }
    },
  }
}

export const thorchainProvider = (fetchFn: FetchFn, chains: Chain[] = []) => thorProvider(fetchFn, THORCHAIN, chains)
export const mayaProvider = (fetchFn: FetchFn, chains: Chain[] = []) => thorProvider(fetchFn, MAYA, chains)
