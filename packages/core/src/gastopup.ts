import { createPublicClient, http } from 'viem'
import type { GasTopUpSetting } from './settings.ts'
import { isNative } from './tokens.ts'
import type { Chain, FetchFn, Token } from './types.ts'

export interface GasTopUp {
  /** What is sent: the same token as the main transfer. */
  from: Token
  /** The destination chain's own coin. */
  to: Token
  amount: bigint
  usd: number
}

/** Sanity limit on what can ever be routed as gas, whatever the setting says. */
export const MAX_GAS_TOP_UP_USD = 50

/** Gas units of one onward transaction on the destination (a bridge deposit or a swap): the work the extra gas is for. */
export const ONWARD_GAS_UNITS = 150_000n

/**
 * USD cost of `gasUnits` of gas on an EVM chain at its current gas price (the node's own
 * average estimate), or undefined when the chain's price or coin price is not known.
 */
export async function estimateGasUsd(chain: Chain, fetchFn: FetchFn, gasUnits: bigint = ONWARD_GAS_UNITS): Promise<number | undefined> {
  if (chain.family !== 'evm' || !chain.nativePriceUsd || chain.rpcUrls.length === 0) return undefined
  for (const url of chain.rpcUrls) {
    try {
      const price = await createPublicClient({ transport: http(url, { fetchFn }) }).getGasPrice()
      return (Number(price * gasUnits) / 1e18) * chain.nativePriceUsd
    } catch {
      // try the next endpoint
    }
  }
  return undefined
}

/** Overrides from a command line or plan file: "off", "3x" (multiplier) or "$5" (fixed USD). */
export function parseGasTopUp(text: string, base: GasTopUpSetting): GasTopUpSetting {
  const t = text.trim().toLowerCase()
  if (t === 'off') return { ...base, mode: 'off' }
  const mult = /^(\d+(?:\.\d+)?)x$/.exec(t)
  if (mult) {
    const n = Number(mult[1])
    if (!(n >= 0.5 && n <= 20)) throw new Error('The gas multiplier must be between 0.5 and 20')
    return { ...base, mode: 'multiplier', multiplier: n }
  }
  const fixed = /^\$(\d+(?:\.\d+)?)$/.exec(t)
  if (fixed) {
    const n = Number(fixed[1])
    if (!(n >= 0.1 && n <= MAX_GAS_TOP_UP_USD)) throw new Error(`The fixed gas amount must be between $0.10 and $${MAX_GAS_TOP_UP_USD}`)
    return { ...base, mode: 'fixed', fixedUsd: n }
  }
  throw new Error(`"${text}" is not a gas top-up setting; use off, a multiplier like 2x, or a fixed value like $3`)
}

export interface GasTopUpInput {
  /** The token the main transfer sends, with its price. */
  source: Token
  /** What the main transfer receives. */
  destination: Token
  /** The destination chain's own coin. */
  destNative: Token
  /** Balance of that coin at the recipient. */
  destNativeBalance: bigint
  /** Amount of `source` the main transfer sends. */
  mainAmount: bigint
  /** Amount of `source` the wallet holds. */
  sourceBalance: bigint
  /** Estimated USD gas cost of what has to be done on the destination chain; needed for the multiplier mode. */
  estimatedGasUsd?: number
}

/**
 * The value of the extra transfer: the multiplier times the estimated gas cost, or the fixed
 * value. Undefined (with a reason) when it cannot be worked out.
 */
export function gasTopUpUsd(setting: GasTopUpSetting, estimatedGasUsd: number | undefined): { usd?: number; why?: string } {
  if (setting.mode === 'off') return {}
  if (setting.mode === 'fixed') return { usd: Math.min(setting.fixedUsd, MAX_GAS_TOP_UP_USD) }
  if (!estimatedGasUsd) return { why: 'the gas price of the destination chain is unknown, so the amount cannot be estimated (set a fixed value with "chainer config set gasTopUpMode fixed")' }
  return { usd: Math.min(estimatedGasUsd * setting.multiplier, MAX_GAS_TOP_UP_USD) }
}

/**
 * A small extra transfer into the destination's own coin, for a recipient that has none there
 * and so could not move what arrives. Returns no top-up (with the reason in `why`) whenever it
 * is off, not needed, or cannot be paid for on top of the main transfer.
 */
export function planGasTopUp(setting: GasTopUpSetting, input: GasTopUpInput): { topUp?: GasTopUp; why?: string } {
  if (setting.mode === 'off') return {}
  if (isNative(input.destination)) return { why: 'the transfer already delivers the destination coin' }
  if (input.destNativeBalance > 0n) return { why: 'the recipient already has gas on the destination' }
  const { usd, why } = gasTopUpUsd(setting, input.estimatedGasUsd)
  if (!usd) return { why }
  const price = input.source.priceUsd
  if (!price) return { why: 'the price of the token is unknown, so the extra amount cannot be worked out' }
  const amount = BigInt(Math.ceil((usd / price) * 10 ** input.source.decimals))
  if (amount * 2n > input.mainAmount) return { why: 'the transfer is too small to add the extra amount' }
  if (input.mainAmount + amount > input.sourceBalance) return { why: 'the wallet cannot pay the extra amount on top of the transfer' }
  return { topUp: { from: input.source, to: input.destNative, amount, usd } }
}
