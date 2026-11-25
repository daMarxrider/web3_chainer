import { encodeFunctionData, pad, type Address, type Hex } from 'viem'
import { estimateGasUsd } from '../gastopup.ts'
import { fetchJson } from '../http.ts'
import type { Action, BridgeProvider, Chain, FetchFn, Quote, QuoteRequest, TransferStatus } from '../types.ts'

/**
 * Circle CCTP v2, called directly: USDC is burned on the source chain and minted on the
 * destination by Circle's Forwarding Service, so the wallet never needs gas on the
 * destination chain and the app only ever signs one transaction. The Iris attestation API
 * is public and keyless. Terms: see "Third-party terms" in docs/PLAN.md (Circle CCTP).
 */
const IRIS = { mainnet: 'https://iris-api.circle.com', testnet: 'https://iris-api-sandbox.circle.com' }

const TOKEN_MESSENGER = { mainnet: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', testnet: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' } as const

/** Magic bytes "cctp-forward", version 0, no extra data: the Forwarding Service hook (Circle docs). */
const FORWARD_HOOK: Hex = '0x636374702d666f72776172640000000000000000000000000000000000000000'

interface CctpChain {
  /** EVM chain id. */
  id: number
  /** Circle's domain number for the chain. */
  domain: number
  usdc: string
  testnet: boolean
}

/** Chains where both CCTP v2 and the Forwarding Service are live (Circle's supported-chains page). */
export const CCTP_CHAINS: CctpChain[] = [
  { id: 1, domain: 0, usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', testnet: false },
  { id: 43114, domain: 1, usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', testnet: false },
  { id: 10, domain: 2, usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', testnet: false },
  { id: 42161, domain: 3, usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', testnet: false },
  { id: 8453, domain: 6, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', testnet: false },
  { id: 137, domain: 7, usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', testnet: false },
  { id: 130, domain: 10, usdc: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', testnet: false },
  { id: 59144, domain: 11, usdc: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', testnet: false },
  { id: 146, domain: 13, usdc: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894', testnet: false },
  { id: 480, domain: 14, usdc: '0x79A02482A880bCe3F13E09da970dC34dB4cD24D1', testnet: false },
  { id: 1329, domain: 16, usdc: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', testnet: false },
  { id: 50, domain: 18, usdc: '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1', testnet: false },
  { id: 999, domain: 19, usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', testnet: false },
  { id: 57073, domain: 21, usdc: '0x2D270e6886d130D724215A266106e6832161EAEd', testnet: false },
  { id: 98866, domain: 22, usdc: '0x222365EF19F7947e5484218551B56bb3965Aa7aF', testnet: false },
  { id: 11155111, domain: 0, usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', testnet: true },
  { id: 43113, domain: 1, usdc: '0x5425890298aed601595a70AB815c96711a31Bc65', testnet: true },
  { id: 11155420, domain: 2, usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', testnet: true },
  { id: 421614, domain: 3, usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', testnet: true },
  { id: 84532, domain: 6, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', testnet: true },
  { id: 80002, domain: 7, usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', testnet: true },
  { id: 1301, domain: 10, usdc: '0x31d0220469e10c4E71834a79b1f276d740d3768F', testnet: true },
  { id: 59141, domain: 11, usdc: '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7', testnet: true },
  { id: 4801, domain: 14, usdc: '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88', testnet: true },
  { id: 5042002, domain: 26, usdc: '0x3600000000000000000000000000000000000000', testnet: true },
]

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const FAST = 1000
const STANDARD = 2000

interface FeeEntry {
  finalityThreshold: number
  /** CCTP protocol fee in basis points of the amount. */
  minimumFee: number
  /** Forwarding Service fee in USDC subunits (6 decimals), by priority. */
  forwardFee: { low: number; med: number; high: number }
}

interface IrisMessages {
  messages?: { status?: string; forwardState?: string; forwardTxHash?: string }[]
}

const burnAbi = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

/** Protocol fee (basis points, may be fractional) of an amount, rounded up so maxFee always covers it. */
const protocolFee = (amount: bigint, bps: number) => (amount * BigInt(Math.round(bps * 100)) + 999_999n) / 1_000_000n

export function cctpProvider(fetchFn: FetchFn, chains: Chain[]): BridgeProvider {
  const find = (chainKey: string) => {
    const chain = chains.find((c) => c.key === chainKey)
    return chain?.family === 'evm' ? CCTP_CHAINS.find((c) => c.id === chain.id) : undefined
  }

  return {
    name: 'cctp',
    traits: { nonCustodial: true, needsApiKey: false },

    async getQuotes(request: QuoteRequest): Promise<Quote[]> {
      const from = find(request.from.chainKey)
      const to = find(request.to.chainKey)
      if (!from || !to || from.id === to.id || from.testnet !== to.testnet) return []
      if (!same(request.from.address, from.usdc) || !same(request.to.address, to.usdc)) return []

      const host = from.testnet ? IRIS.testnet : IRIS.mainnet
      // Approval plus burn on the source chain: about 250 000 gas used, 300 000 assumed, at the node's current price.
      const sourceChain = chains.find((c) => c.key === request.from.chainKey)
      const gasUsd = (sourceChain && (await estimateGasUsd(sourceChain, fetchFn, 300_000n))) || 0
      const fees = await fetchJson<FeeEntry[]>(fetchFn, `${host}/v2/burn/USDC/fees/${from.domain}/${to.domain}?forward=true`)

      const quotes: Quote[] = []
      for (const fee of fees) {
        if (fee.finalityThreshold !== FAST && fee.finalityThreshold !== STANDARD) continue
        // The burned amount is what the wallet sends; the fees come out of it on the destination chain.
        const maxFee = BigInt(fee.forwardFee.med) + protocolFee(request.amount, fee.minimumFee)
        if (request.amount <= maxFee) continue
        const worstFee = BigInt(fee.forwardFee.high) + protocolFee(request.amount, fee.minimumFee)
        const received = request.amount - maxFee
        const fast = fee.finalityThreshold === FAST
        quotes.push({
          provider: 'cctp',
          tool: fast ? 'cctp-fast' : 'cctp-standard',
          request,
          // Circle takes at most maxFee, so a transfer never gets less than the expected amount for the same quote. The forwarding fee moves between
          // quotes, though, so the worst case a run guards against is priced at Circle's "high" fee level.
          toAmount: received,
          toAmountMin: request.amount > worstFee ? request.amount - worstFee : received,
          toAmountUsd: Number(received) / 1e6,
          // Gas of the approval and the burn on the source chain; the forwarding fee is already inside maxFee.
          costUsd: gasUsd,
          etaSeconds: fast ? 30 : 1200,
          viaSymbols: ['USDC'],
          raw: { fromId: from.id, toId: to.id, maxFee: maxFee.toString(), threshold: fee.finalityThreshold },
          statusRef: { srcDomain: from.domain, testnet: from.testnet ? 1 : 0, expected: received.toString() },
        })
      }
      return quotes
    },

    async buildActions(quote: Quote): Promise<Action[]> {
      const { request } = quote
      const raw = quote.raw as { fromId: number; maxFee: string; threshold: number }
      const from = CCTP_CHAINS.find((c) => c.id === raw.fromId)!
      const to = find(request.to.chainKey)!
      if (!/^0x[0-9a-fA-F]{40}$/.test(request.toAddress)) throw new Error('The CCTP destination must be an EVM address')
      const messenger = (from.testnet ? TOKEN_MESSENGER.testnet : TOKEN_MESSENGER.mainnet) as Address
      const data = encodeFunctionData({
        abi: burnAbi,
        functionName: 'depositForBurnWithHook',
        args: [
          request.amount,
          to.domain,
          pad(request.toAddress as Hex, { size: 32 }),
          from.usdc as Address,
          pad('0x', { size: 32 }),
          BigInt(raw.maxFee),
          raw.threshold,
          FORWARD_HOOK,
        ],
      })
      return [
        {
          kind: 'evm-tx',
          chainKey: request.from.chainKey,
          to: messenger,
          data,
          value: 0n,
          approval: { token: from.usdc, spender: messenger, amount: request.amount },
        },
      ]
    },

    async getStatus(txId, ref): Promise<TransferStatus> {
      const host = ref.testnet ? IRIS.testnet : IRIS.mainnet
      let body: IrisMessages
      try {
        body = await fetchJson<IrisMessages>(fetchFn, `${host}/v2/messages/${ref.srcDomain}?transactionHash=${txId}`)
      } catch (err) {
        // Iris answers 404 until it has seen the burn.
        return { state: 'pending', detail: (err as Error).message }
      }
      const message = body.messages?.[0]
      if (!message) return { state: 'pending', detail: 'Waiting for Circle to see the burn' }
      if (message.forwardTxHash) return { state: 'done', detail: 'Minted by the Forwarding Service', destTxId: message.forwardTxHash }
      if (message.forwardState?.toUpperCase() === 'FAILED') return { state: 'failed', detail: 'The Forwarding Service reported a failure; the USDC is burned and can still be minted by hand with the attestation' }
      return { state: 'pending', detail: message.status === 'complete' ? 'Attested; waiting for the mint on the destination chain' : 'Waiting for the attestation' }
    },
  }
}
