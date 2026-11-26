import { routeNetUsd, type Route } from './pipeline.ts'
import { isNative } from './tokens.ts'
import type { Token } from './types.ts'

/** A token the wallet holds on the source chain. */
export interface Holding {
  token: Token
  balance: bigint
}

export interface SweepItem {
  from: Token
  to: Token
  amount: bigint
  route: Route
}
export interface SweepSkip {
  token: Token
  reason: string
}
export interface SweepPlan {
  /** In the order they should run: tokens by value, the chain's own coin last. */
  items: SweepItem[]
  skipped: SweepSkip[]
}

export interface SweepInput {
  holdings: Holding[]
  /** The token to receive for a held token, or undefined when the destination has none. */
  target(token: Token): Token | undefined
  /**
   * Whether a token is the chain's gas coin. Defaults to the native coin; chains whose gas token also
   * exists as a token (USDC on Arc) must say so, or a sweep would send the gas away with everything else.
   */
  isGasCoin?(token: Token): boolean
  /** Best route for one transfer, or undefined when there is none. */
  findRoute(from: Token, to: Token, amount: bigint): Promise<Route | undefined>
}

/** A route search that failed is reported with its reason, never mistaken for "no route". */
type Search = { route?: Route; failed?: string }
const search = (find: SweepInput['findRoute'], from: Token, to: Token, amount: bigint): Promise<Search> =>
  find(from, to, amount).then(
    (route) => ({ route }),
    (err: Error) => ({ failed: `the route search failed: ${err.message}` }),
  )

const valueUsd = (token: Token, amount: bigint) => (token.priceUsd === undefined ? undefined : (Number(amount) / 10 ** token.decimals) * token.priceUsd)
const firstLegCost = (route: Route) => route.legs[0]!.costUsd
/** Gas can rise between quote and send, so the amount held back is three times the quoted cost. */
const GAS_MARGIN = 3

/**
 * Plans a whole-wallet transfer: every held token becomes its own transfer. Tokens with no
 * matching token on the destination, no route, or fees above their value are skipped and
 * reported. The chain's own coin goes last with enough held back to pay for the other
 * transfers and for its own.
 */
export async function planSweep(input: SweepInput): Promise<SweepPlan> {
  const held = input.holdings.filter((h) => h.balance > 0n)
  const gas = input.isGasCoin ?? ((t: Token) => isNative(t))
  const tokens = held.filter((h) => !gas(h.token)).sort((a, b) => (valueUsd(b.token, b.balance) ?? 0) - (valueUsd(a.token, a.balance) ?? 0))
  const native = held.find((h) => gas(h.token))
  const items: SweepItem[] = []
  const skipped: SweepSkip[] = []

  /** Why a quoted route is not worth running, or undefined if it is. */
  const notWorth = (route: Route, from: Token, amount: bigint): string | undefined => {
    const value = valueUsd(from, amount)
    const net = routeNetUsd(route)
    if (net !== undefined && net <= 0) return 'fees and gas are higher than the amount received'
    if (value !== undefined && route.legs.reduce((s, q) => s + q.costUsd, 0) >= value) return 'fees and gas are higher than its value'
    return undefined
  }

  for (const h of tokens) {
    const to = input.target(h.token)
    if (!to) {
      skipped.push({ token: h.token, reason: 'no matching token on the destination' })
      continue
    }
    const { route, failed } = await search(input.findRoute, h.token, to, h.balance)
    if (!route) {
      skipped.push({ token: h.token, reason: failed ?? 'no route' })
      continue
    }
    const why = notWorth(route, h.token, h.balance)
    if (why) skipped.push({ token: h.token, reason: why })
    else items.push({ from: h.token, to, amount: h.balance, route })
  }

  if (native) {
    const to = input.target(native.token)
    const price = native.token.priceUsd
    if (!to) skipped.push({ token: native.token, reason: 'no matching token on the destination' })
    else if (!price) skipped.push({ token: native.token, reason: 'its price is unknown, so the gas to hold back cannot be worked out' })
    else {
      const toNative = (usd: number) => BigInt(Math.ceil((usd / price) * 10 ** native.token.decimals))
      // Gas of the transfers above all comes out of this coin; so does the cost of its own transfer.
      const others = toNative(items.reduce((s, i) => s + firstLegCost(i.route), 0) * GAS_MARGIN)
      let amount = native.balance - others
      let why: string | undefined
      let route: Route | undefined
      if (amount <= 0n) why = 'the balance is too small to cover the gas of the other transfers'
      else {
        const first = await search(input.findRoute, native.token, to, amount)
        if (!first.route) why = first.failed ?? 'no route'
        else {
          amount -= toNative(firstLegCost(first.route) * GAS_MARGIN)
          if (amount <= 0n) why = 'the balance is too small to cover the gas of its own transfer'
          else {
            const second = await search(input.findRoute, native.token, to, amount)
            route = second.route
            why = route ? notWorth(route, native.token, amount) : (second.failed ?? 'no route')
          }
        }
      }
      if (route && !why) items.push({ from: native.token, to, amount, route })
      else skipped.push({ token: native.token, reason: why ?? 'no route' })
    }
  }
  return { items, skipped }
}
