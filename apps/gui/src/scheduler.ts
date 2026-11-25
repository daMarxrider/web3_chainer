import { type PipelineRecord, afterRun, dueState, feesAcceptable, geoKeys, newSchedule, routeCostUsd, type Route, type Schedule, type Trigger } from '@chainer/core'
import { engine } from './engine.ts'
import { setJob } from './status.ts'

export { newSchedule }
export type { Trigger }

let timer: ReturnType<typeof setInterval> | undefined
let busy = false

/**
 * Carries out due schedules while the app is open and the wallet unlocked. Nobody is there to
 * answer questions, so only the location confirmations given when the schedule was made count,
 * and a run that needs another one is skipped.
 */
export function startScheduler(): void {
  stopScheduler()
  timer = setInterval(() => void tick(), 30_000)
  void tick()
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

async function tick(): Promise<void> {
  if (busy || !engine.session) return
  busy = true
  try {
    for (const s of await engine.schedules()) {
      const due = dueState(s, new Date())
      if (due === 'wait') continue
      await engine.saveSchedule(await runOne(s, due))
      document.dispatchEvent(new Event('chainer:schedules'))
    }
  } finally {
    busy = false
  }
}

/** A run that ends stopped is a failure of the schedule, with the reason the leg gave. */
function failIfStopped(record: PipelineRecord): PipelineRecord {
  if (record.state === 'done') return record
  const bad = record.legs.find((l) => l.state === 'failed')
  throw new Error(`The transfer stopped${bad?.error ? `: ${bad.error}` : ''}. Resume it from History.`)
}

/** Quotes the schedule's saved route and, if its conditions hold, runs it. */
async function runOne(s: Schedule, mode: 'run' | 'check'): Promise<Schedule> {
  const now = new Date()
  const say = (text: string) => setJob('working', `Schedule "${s.route}": ${text}`)
  try {
    const saved = await engine.loadRoute(s.route)
    say(mode === 'check' ? 'checking fees' : 'quoting')
    const routes: Route[] = []
    let start: () => Promise<unknown>
    if (saved.kind === 'transfer') {
      const prep = await engine.prepareSaved(saved)
      routes.push(prep.route)
      start = async () => failIfStopped(await engine.runAuto(prep.route, s.geoAccepted, (_r, i, m) => say(`leg ${i + 1}: ${m}`), { wholeBalance: prep.wholeBalance }))
    } else {
      const [fc, tc] = await Promise.all([engine.resolveChain(saved.fromChain), engine.resolveChain(saved.toChain)])
      const { plan } = await engine.planSweep(fc, tc, saved.tokens, saved.target, saved.recipient)
      routes.push(...plan.items.map((i) => i.route))
      start = async () => {
        const stopped: string[] = []
        for (const item of plan.items) {
          try {
            failIfStopped(await engine.runAuto(item.route, s.geoAccepted, (_r, i, m) => say(`${item.from.symbol}, leg ${i + 1}: ${m}`)))
          } catch (e) {
            stopped.push(`${item.from.symbol}: ${(e as Error).message}`)
          }
        }
        if (stopped.length) throw new Error(stopped.join('; '))
      }
    }
    if (routes.length === 0) return afterRun(s, now, 'nothing to send')

    if (s.trigger.kind === 'when') {
      const total = routes.reduce((sum, r) => sum + routeCostUsd(r), 0)
      if (!feesAcceptable({ legs: routes.flatMap((r) => r.legs) }, s.trigger.feesBelowUsd)) {
        setJob('idle', `Schedule "${s.route}": fees $${total.toFixed(2)} above the limit, waiting`)
        return { ...s, lastCheck: now.toISOString(), lastResult: 'waiting for lower fees' }
      }
    }
    // Only confirmations given at creation count; a restricted service they do not cover means no run.
    const needed = [...new Set(routes.flatMap((r) => geoKeys(r.legs)))]
    if (!engine.testMode && !needed.every((k) => s.geoAccepted.includes(k))) {
      setJob('failed', `Schedule "${s.route}" skipped: needs a location confirmation`)
      return afterRun(s, now, 'skipped: a restricted service was not confirmed when this schedule was created')
    }
    await start()
    setJob('done', `Schedule "${s.route}" finished`)
    return afterRun(s, now, 'ok')
  } catch (err) {
    setJob('failed', `Schedule "${s.route}": ${(err as Error).message}`)
    return afterRun(s, now, (err as Error).message)
  }
}
