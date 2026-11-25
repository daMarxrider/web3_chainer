import type { Route } from './pipeline.ts'
import type { Store } from './types.ts'

/** When a saved route runs. */
export type Trigger =
  /** Once, at a time. */
  | { kind: 'at'; at: string }
  /** Repeatedly; the first run is `start` (or right away when absent). */
  | { kind: 'every'; everyMs: number; start?: string }
  /** When the route's total gas and fees are at or below a limit, checked every `checkEveryMs`; runs once, then repeats only if `repeat`. */
  | { kind: 'when'; feesBelowUsd: number; checkEveryMs: number; repeat: boolean }

export interface Schedule {
  id: string
  /** Name of the saved route to run. */
  route: string
  trigger: Trigger
  /**
   * Bridge keys with geo restrictions the user confirmed their location for when creating the
   * schedule. A run that needs another one is skipped: nobody is there to answer the question.
   */
  geoAccepted: string[]
  createdAt: string
  lastRun?: string
  lastCheck?: string
  lastResult?: string
  /** Set when a one-time schedule has run. */
  done?: boolean
}

export type Due = 'run' | 'check' | 'wait'

/**
 * What the daemon should do with a schedule now: run it, check its condition (the caller quotes
 * the route and calls `feesAcceptable`), or leave it. A "when" schedule runs only after a check.
 */
export function dueState(s: Schedule, now: Date): Due {
  if (s.done) return 'wait'
  const t = now.getTime()
  const since = (iso?: string) => (iso ? t - new Date(iso).getTime() : Infinity)
  switch (s.trigger.kind) {
    case 'at':
      return t >= new Date(s.trigger.at).getTime() ? 'run' : 'wait'
    case 'every': {
      if (s.trigger.start && t < new Date(s.trigger.start).getTime()) return 'wait'
      return since(s.lastRun) >= s.trigger.everyMs ? 'run' : 'wait'
    }
    case 'when':
      return since(s.lastCheck) >= s.trigger.checkEveryMs ? 'check' : 'wait'
  }
}

/** Total gas and fees of a quoted route, against the limit of a "when" schedule. */
export const routeCostUsd = (route: Route) => route.legs.reduce((sum, q) => sum + q.costUsd + (q.riskUsd ?? 0), 0)
export const feesAcceptable = (route: Route, limitUsd: number) => routeCostUsd(route) <= limitUsd

/** What a finished run changes in the schedule. */
export function afterRun(s: Schedule, now: Date, result: string): Schedule {
  const next = { ...s, lastRun: now.toISOString(), lastCheck: now.toISOString(), lastResult: result }
  if (s.trigger.kind === 'at' || (s.trigger.kind === 'when' && !s.trigger.repeat)) next.done = true
  return next
}

const UNITS: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }
/** "30m", "6h", "1d" to milliseconds; at least one minute. */
export function parseDuration(text: string): number {
  const m = /^(\d+)\s*([smhd])$/i.exec(text.trim())
  if (!m) throw new Error(`"${text}" is not a duration; use a number and s, m, h or d, e.g. 30m, 6h, 1d`)
  const ms = Number(m[1]) * UNITS[m[2]!.toLowerCase()]!
  if (ms < 60_000) throw new Error('The shortest interval is one minute')
  return ms
}

// ---- storage ----

const PREFIX = 'schedules/'
const file = (id: string) => `${PREFIX}${id}.json`

export async function saveSchedule(store: Store, s: Schedule): Promise<void> {
  await store.set(file(s.id), JSON.stringify(s, null, 2))
}
export async function listSchedules(store: Store): Promise<Schedule[]> {
  const raws = await Promise.all((await store.keys(PREFIX)).map((k) => store.get(k)))
  return raws.filter((r): r is string => !!r).map((r) => JSON.parse(r) as Schedule).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
export async function removeSchedule(store: Store, idOrPrefix: string): Promise<Schedule> {
  const found = (await listSchedules(store)).filter((s) => s.id.startsWith(idOrPrefix))
  if (found.length !== 1) throw new Error(found.length ? `"${idOrPrefix}" matches several schedules; give more characters` : `No schedule "${idOrPrefix}"`)
  // The Store has no delete; an empty value reads back as gone.
  await store.set(file(found[0]!.id), '')
  return found[0]!
}

export function newSchedule(route: string, trigger: Trigger, geoAccepted: string[]): Schedule {
  return { id: crypto.randomUUID(), route, trigger, geoAccepted, createdAt: new Date().toISOString() }
}
