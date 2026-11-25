import assert from 'node:assert/strict'
import { test } from 'node:test'
import { afterRun, dueState, feesAcceptable, listSchedules, newSchedule, parseDuration, removeSchedule, saveSchedule, type Quote, type Route, type Schedule, type Store } from '../src/index.ts'

const memory = (): Store => {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)) }
}
const at = (iso: string) => new Date(iso)
const sched = (trigger: Schedule['trigger'], over: Partial<Schedule> = {}): Schedule => ({ ...newSchedule('r', trigger, []), ...over })
const route = (...costs: number[]): Route => ({ legs: costs.map((c) => ({ costUsd: c }) as unknown as Quote) })

test('a one-time schedule runs once, after its time', () => {
  const s = sched({ kind: 'at', at: '2026-12-01T10:00:00Z' })
  assert.equal(dueState(s, at('2026-12-01T09:59:00Z')), 'wait')
  assert.equal(dueState(s, at('2026-12-01T10:00:00Z')), 'run')
  const ran = afterRun(s, at('2026-12-01T10:00:30Z'), 'ok')
  assert.equal(dueState(ran, at('2026-12-02T10:00:00Z')), 'wait')
})

test('a repeating schedule runs at its start, then every interval', () => {
  const s = sched({ kind: 'every', everyMs: 3600_000, start: '2026-12-01T10:00:00Z' })
  assert.equal(dueState(s, at('2026-12-01T09:00:00Z')), 'wait')
  assert.equal(dueState(s, at('2026-12-01T10:00:00Z')), 'run')
  const ran = afterRun(s, at('2026-12-01T10:00:00Z'), 'ok')
  assert.equal(dueState(ran, at('2026-12-01T10:59:00Z')), 'wait')
  assert.equal(dueState(ran, at('2026-12-01T11:00:00Z')), 'run')
})

test('a fee condition is checked on its interval and only runs when the fees are low enough', () => {
  const s = sched({ kind: 'when', feesBelowUsd: 3, checkEveryMs: 1800_000, repeat: false })
  assert.equal(dueState(s, at('2026-12-01T10:00:00Z')), 'check')
  const checked = { ...s, lastCheck: '2026-12-01T10:00:00Z' }
  assert.equal(dueState(checked, at('2026-12-01T10:20:00Z')), 'wait')
  assert.equal(dueState(checked, at('2026-12-01T10:30:00Z')), 'check')
  assert.equal(feesAcceptable(route(1, 2), 3), true)
  assert.equal(feesAcceptable(route(1, 2.5), 3), false)
  assert.equal(afterRun(checked, at('2026-12-01T10:30:00Z'), 'ok').done, true)
  assert.equal(afterRun({ ...checked, trigger: { kind: 'when', feesBelowUsd: 3, checkEveryMs: 1, repeat: true } }, at('2026-12-01T10:30:00Z'), 'ok').done, undefined)
})

test('durations', () => {
  assert.equal(parseDuration('30m'), 1_800_000)
  assert.equal(parseDuration('1d'), 86_400_000)
  assert.throws(() => parseDuration('10s'), /one minute/)
  assert.throws(() => parseDuration('soon'), /not a duration/)
})

test('schedules are stored, listed and removed by id prefix', async () => {
  const store = memory()
  const a = sched({ kind: 'at', at: '2026-12-01T10:00:00Z' })
  await saveSchedule(store, a)
  assert.equal((await listSchedules(store)).length, 1)
  await removeSchedule(store, a.id.slice(0, 6))
  assert.equal((await listSchedules(store)).length, 0)
  await assert.rejects(removeSchedule(store, 'zzz'), /No schedule/)
})
