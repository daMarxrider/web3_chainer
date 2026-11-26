import type { Route } from './pipeline.ts'
import type { Store } from './types.ts'

/**
 * A route kept under a name instead of being run. It stores what the user meant (wallet,
 * tokens, chains, amount rule, recipient) and, for a single transfer, the path that was chosen.
 * Prices and fees are not stored: they are quoted again along the path when it runs.
 */
export interface SavedTransfer {
  kind: 'transfer'
  name: string
  createdAt: string
  /** Wallet name; the run falls back to the default wallet when absent. */
  wallet?: string
  /** "SYMBOL@chainKey", resolved again at run time (this also lets test mode map them to test networks). */
  from: string
  to: string
  /** Smallest units of `from`, or "all": whatever the wallet holds when it runs. */
  amount: string
  /** Address book label or address as typed; absent means the wallet's own address. */
  recipient?: string
  /** The chosen path, "provider/tool > provider/tool", as shown by `chainer quote`. */
  via: string
  /** Stop when the worst-case result is below this (smallest units of the destination token). */
  minReceive?: string
  /** If the stored path is no longer offered, use the best route at that moment instead of stopping. */
  fallback: boolean
}

export interface SavedSweep {
  kind: 'sweep'
  name: string
  createdAt: string
  wallet?: string
  fromChain: string
  toChain: string
  tokens?: string[]
  target?: string
  recipient?: string
}

export type SavedRoute = SavedTransfer | SavedSweep

const PREFIX = 'routes/'
const valid = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
const file = (name: string) => `${PREFIX}${name.toLowerCase()}.json`

export async function saveRoute(store: Store, route: SavedRoute): Promise<void> {
  if (!valid(route.name)) throw new Error(`"${route.name}" is not a usable name: use letters, digits, dots, dashes or underscores`)
  if (await store.get(file(route.name))) throw new Error(`A saved route named "${route.name}" exists; remove it first or pick another name`)
  await store.set(file(route.name), JSON.stringify(route, null, 2))
}

export async function loadRoute(store: Store, name: string): Promise<SavedRoute> {
  // A name that could never have been saved (../x) is not looked up: it could reach other files.
  const raw = valid(name) ? await store.get(file(name)) : null
  if (!raw) throw new Error(`No saved route "${name}". List them with "chainer route list".`)
  return JSON.parse(raw) as SavedRoute
}

export async function listRoutes(store: Store): Promise<SavedRoute[]> {
  const keys = await store.keys(PREFIX)
  const raws = await Promise.all(keys.map((k) => store.get(k)))
  const routes = raws.filter((r): r is string => !!r).map((r) => JSON.parse(r) as SavedRoute)
  return routes.sort((a, b) => a.name.localeCompare(b.name))
}

export async function removeRoute(store: Store, name: string): Promise<void> {
  // Checked first: removing writes an empty value, which must never land on another file (../keystore).
  if (!valid(name)) throw new Error(`No saved route "${name}"`)
  const key = file(name)
  if (!(await store.get(key))) throw new Error(`No saved route "${name}"`)
  // The Store has no delete; an empty value is read back as "gone".
  await store.set(key, '')
}

/** The text that identifies a route's path, the same one `chainer quote` prints. */
export const routePath = (route: Route) => route.legs.map((q) => `${q.provider}/${q.tool}`).join(' > ')

export type SavedChoice = { route: Route; usedFallback: boolean }

/**
 * Picks the route to run for a saved transfer from freshly searched ones: the stored path if it
 * is still offered, else the best route when the user allowed the fallback, else a refusal
 * that says so. A result below the saved minimum always stops the run.
 */
export function chooseSaved(saved: Pick<SavedTransfer, 'via' | 'fallback' | 'minReceive'>, fresh: Route[]): SavedChoice {
  const same = fresh.find((r) => routePath(r) === saved.via)
  if (!same && !saved.fallback) throw new Error(`The saved path "${saved.via}" is no longer offered. Run it again with the fallback allowed, or save a new route.`)
  const route = same ?? fresh[0]
  if (!route) throw new Error('No route found at the moment')
  if (saved.minReceive !== undefined && route.legs.at(-1)!.toAmountMin < BigInt(saved.minReceive)) {
    throw new Error(`The result (${route.legs.at(-1)!.toAmountMin} at worst) is below the minimum you saved (${saved.minReceive}); nothing was sent`)
  }
  return { route, usedFallback: !same }
}
