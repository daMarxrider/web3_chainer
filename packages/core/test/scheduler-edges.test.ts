import assert from 'node:assert/strict'
import { test } from 'node:test'
import { afterRun, dueState, feesAcceptable, listSchedules, parseDuration, removeSchedule, routeCostUsd, saveSchedule, type Quote, type Route, type Schedule, type Store, type Trigger } from '../src/index.ts'

// ---- fixtures ----

const NOW = new Date('2026-11-26T12:00:00.000Z')
const ms = (iso: string) => new Date(iso).getTime()
const HOUR = 3_600_000
const schedule = (trigger: Trigger, extra: Partial<Schedule> = {}): Schedule => ({ id: 'abc123', route: 'nightly', trigger, geoAccepted: [], createdAt: '2026-11-01T00:00:00.000Z', ...extra })
const ago = (msBack: number) => new Date(NOW.getTime() - msBack).toISOString()
function memoryStore(): Store {
  const data = new Map<string, string>()
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async (p) => [...data.keys()].filter((k) => k.startsWith(p)) }
}
const leg = (costUsd: number, riskUsd?: number) => ({ costUsd, riskUsd }) as Quote
const route = (...legs: Quote[]): Route => ({ legs })

// ---- when a schedule is due ----

test('a one-time schedule is due at exactly its time', () => {
  assert.equal(dueState(schedule({ kind: 'at', at: NOW.toISOString() }), NOW), 'run')
})

test('a one-time schedule waits until a millisecond before its time', () => {
  assert.equal(dueState(schedule({ kind: 'at', at: new Date(ms(NOW.toISOString()) + 1).toISOString() }), NOW), 'wait')
})

test('a finished schedule always waits', () => {
  assert.equal(dueState(schedule({ kind: 'at', at: ago(HOUR) }, { done: true }), NOW), 'wait')
})

test('a repeating schedule without a start runs right away the first time', () => {
  assert.equal(dueState(schedule({ kind: 'every', everyMs: HOUR }), NOW), 'run')
})

test('a repeating schedule waits for a start in the future, even before its first run', () => {
  assert.equal(dueState(schedule({ kind: 'every', everyMs: HOUR, start: new Date(NOW.getTime() + 1).toISOString() }), NOW), 'wait')
})

test('a repeating schedule runs again when exactly its interval has passed', () => {
  assert.equal(dueState(schedule({ kind: 'every', everyMs: HOUR }, { lastRun: ago(HOUR) }), NOW), 'run')
})

test('a repeating schedule waits when its interval is a millisecond short', () => {
  assert.equal(dueState(schedule({ kind: 'every', everyMs: HOUR }, { lastRun: ago(HOUR - 1) }), NOW), 'wait')
})

test('a fee condition never checked is checked now', () => {
  assert.equal(dueState(schedule({ kind: 'when', feesBelowUsd: 1, checkEveryMs: HOUR, repeat: false }), NOW), 'check')
})

test('a fee condition checked within its interval waits', () => {
  assert.equal(dueState(schedule({ kind: 'when', feesBelowUsd: 1, checkEveryMs: HOUR, repeat: false }, { lastCheck: ago(HOUR - 1) }), NOW), 'wait')
})

test('a fee condition is never run without a check first', () => {
  assert.notEqual(dueState(schedule({ kind: 'when', feesBelowUsd: 1, checkEveryMs: HOUR, repeat: true }, { lastCheck: ago(2 * HOUR), lastRun: ago(2 * HOUR) }), NOW), 'run')
})

// ---- fees ----

test('a route’s cost adds every leg’s gas and fees and its expected price-impact loss', () => {
  assert.equal(routeCostUsd(route(leg(0.25, 0.5), leg(1))), 1.75)
})

test('fees exactly at the limit are acceptable', () => {
  assert.equal(feesAcceptable(route(leg(0.5), leg(0.5)), 1), true)
})

test('fees above the limit are not acceptable', () => {
  assert.equal(feesAcceptable(route(leg(0.5), leg(0.51)), 1), false)
})

// ---- after a run ----

test('a one-time schedule is finished after it ran', () => {
  assert.equal(afterRun(schedule({ kind: 'at', at: ago(1) }), NOW, 'done').done, true)
})

test('a fee condition without repeat is finished after it ran', () => {
  assert.equal(afterRun(schedule({ kind: 'when', feesBelowUsd: 1, checkEveryMs: HOUR, repeat: false }), NOW, 'done').done, true)
})

test('a repeating fee condition goes on after it ran', () => {
  assert.equal(afterRun(schedule({ kind: 'when', feesBelowUsd: 1, checkEveryMs: HOUR, repeat: true }), NOW, 'done').done, undefined)
})

test('a repeating schedule goes on after it ran', () => {
  assert.equal(afterRun(schedule({ kind: 'every', everyMs: HOUR }), NOW, 'done').done, undefined)
})

test('a run records its time as both the last run and the last check, and its result', () => {
  const s = afterRun(schedule({ kind: 'every', everyMs: HOUR }), NOW, 'stopped: no route')
  assert.deepEqual([s.lastRun, s.lastCheck, s.lastResult], [NOW.toISOString(), NOW.toISOString(), 'stopped: no route'])
})

test('a run leaves the schedule it was given unchanged', () => {
  const before = schedule({ kind: 'at', at: ago(1) })
  afterRun(before, NOW, 'done')
  assert.equal(before.done, undefined)
})

// ---- durations ----

test('one minute is the shortest interval', () => {
  assert.equal(parseDuration('60s'), 60_000)
})

test('59 seconds is refused as shorter than a minute', () => {
  assert.throws(() => parseDuration('59s'), /^Error: The shortest interval is one minute$/)
})

test('zero minutes is refused', () => {
  assert.throws(() => parseDuration('0m'), /shortest interval/)
})

test('units are understood in capitals and with spaces around', () => {
  assert.equal(parseDuration(' 2H '), 2 * HOUR)
})

test('a space between number and unit is allowed', () => {
  assert.equal(parseDuration('1 d'), 24 * HOUR)
})

test('a fraction is refused, with an example of what works', () => {
  assert.throws(() => parseDuration('1.5h'), /^Error: "1\.5h" is not a duration; use a number and s, m, h or d, e\.g\. 30m, 6h, 1d$/)
})

test('a number without a unit is refused', () => {
  assert.throws(() => parseDuration('30'), /is not a duration/)
})

test('weeks are not a unit', () => {
  assert.throws(() => parseDuration('1w'), /is not a duration/)
})

// ---- storage ----

test('schedules are listed oldest first', async () => {
  const store = memoryStore()
  await saveSchedule(store, schedule({ kind: 'every', everyMs: HOUR }, { id: 'new', createdAt: '2026-11-26T00:00:00.000Z' }))
  await saveSchedule(store, schedule({ kind: 'every', everyMs: HOUR }, { id: 'old', createdAt: '2026-11-01T00:00:00.000Z' }))
  assert.deepEqual((await listSchedules(store)).map((s) => s.id), ['old', 'new'])
})

test('a removed schedule is no longer listed', async () => {
  const store = memoryStore()
  await saveSchedule(store, schedule({ kind: 'every', everyMs: HOUR }, { id: 'abc123' }))
  await removeSchedule(store, 'abc')
  assert.deepEqual(await listSchedules(store), [])
})

test('a prefix matching two schedules removes neither and asks for more characters', async () => {
  const store = memoryStore()
  await saveSchedule(store, schedule({ kind: 'every', everyMs: HOUR }, { id: 'abc1' }))
  await saveSchedule(store, schedule({ kind: 'every', everyMs: HOUR }, { id: 'abc2' }))
  await assert.rejects(removeSchedule(store, 'abc'), /^Error: "abc" matches several schedules; give more characters$/)
  assert.equal((await listSchedules(store)).length, 2)
})

test('an empty id is refused, even when only one schedule exists', async () => {
  const store = memoryStore()
  await saveSchedule(store, schedule({ kind: 'every', everyMs: HOUR }, { id: 'only' }))
  await assert.rejects(removeSchedule(store, ''), /^Error: No schedule ""$/)
  assert.equal((await listSchedules(store)).length, 1)
})

test('an id no schedule has is reported', async () => {
  await assert.rejects(removeSchedule(memoryStore(), 'zzz'), /^Error: No schedule "zzz"$/)
})
