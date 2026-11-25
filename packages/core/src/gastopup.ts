import type { Settings } from './settings.ts'
import { isNative } from './tokens.ts'
import type { Token } from './types.ts'

export interface GasTopUp {
  /** What is sent: the same token as the main transfer. */
  from: Token
  /** The destination chain's own coin. */
  to: Token
  amount: bigint
  usd: number
}

/** The most that can ever be routed as gas, whatever the setting says. */
export const MAX_GAS_TOP_UP_USD = 10

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
}

/**
 * A small extra transfer into the destination's own coin, for a recipient that has none there
 * and so could not move what arrives. Returns undefined (with the reason in `why`) whenever it
 * is off, not needed, or cannot be paid for on top of the main transfer.
 */
export function planGasTopUp(settings: Pick<Settings, 'gasTopUpUsd'>, input: GasTopUpInput): { topUp?: GasTopUp; why?: string } {
  const usd = Math.min(settings.gasTopUpUsd, MAX_GAS_TOP_UP_USD)
  if (!(usd > 0)) return {}
  if (isNative(input.destination)) return { why: 'the transfer already delivers the destination coin' }
  if (input.destNativeBalance > 0n) return { why: 'the recipient already has gas on the destination' }
  const price = input.source.priceUsd
  if (!price) return { why: 'the price of the token is unknown, so the extra amount cannot be worked out' }
  const amount = BigInt(Math.ceil((usd / price) * 10 ** input.source.decimals))
  if (amount * 2n > input.mainAmount) return { why: 'the transfer is too small to add the extra amount' }
  if (input.mainAmount + amount > input.sourceBalance) return { why: 'the wallet cannot pay the extra amount on top of the transfer' }
  return { topUp: { from: input.source, to: input.destNative, amount, usd } }
}
