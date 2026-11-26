import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { fetchJson } from '../src/http.ts'

const URL_ = 'https://api.example.org/v1/thing'

/** A server that gives the listed responses in turn and records what it was asked. */
function server(...responses: (() => Response)[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!
    return next()
  }) as typeof fetch
  return { fetchFn, calls }
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers })
const text = (body: string, status: number, headers: Record<string, string> = {}) => () => new Response(body, { status, headers })
const rateLimited = (retryAfter?: string) => text('slow down', 429, retryAfter === undefined ? {} : { 'retry-after': retryAfter })

/** Lets pending promise callbacks run, so the code under test reaches its next timer. */
const settle = () => new Promise<void>((r) => setImmediate(r))

// ---- success ----

test('a JSON response is returned parsed', async () => {
  const { fetchFn } = server(json({ amount: '12', ok: true }))
  assert.deepEqual(await fetchJson(fetchFn, URL_), { amount: '12', ok: true })
})

test('the request options are passed on unchanged', async () => {
  const { fetchFn, calls } = server(json({}))
  const init = { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } }
  await fetchJson(fetchFn, URL_, init)
  assert.equal(calls[0]!.init, init)
})

test('a successful response that is not JSON names the service instead of throwing a bare parse error', async () => {
  const { fetchFn } = server(text('<html>Bad gateway</html>', 200))
  await assert.rejects(fetchJson(fetchFn, URL_), { message: 'api.example.org sent a response that is not JSON: <html>Bad gateway</html>' })
})

// ---- errors ----

test('an error response with a JSON message shows the service, the status and the message', async () => {
  const { fetchFn } = server(json({ message: 'Could not find token' }, 404))
  await assert.rejects(fetchJson(fetchFn, URL_), { message: 'api.example.org responded 404: Could not find token' })
})

test('an error response with JSON but no message field shows the body as sent', async () => {
  const { fetchFn } = server(json({ error: 'Message not found' }, 404))
  await assert.rejects(fetchJson(fetchFn, URL_), { message: 'api.example.org responded 404: {"error":"Message not found"}' })
})

test('an error response that is not JSON shows its text', async () => {
  const { fetchFn } = server(text('upstream timed out', 504))
  await assert.rejects(fetchJson(fetchFn, URL_), { message: 'api.example.org responded 504: upstream timed out' })
})

test('a long error body is cut to its first 300 characters', async () => {
  const { fetchFn } = server(text('x'.repeat(1000), 500))
  await assert.rejects(fetchJson(fetchFn, URL_), { message: `api.example.org responded 500: ${'x'.repeat(300)}` })
})

test('an error response is not retried', async () => {
  const { fetchFn, calls } = server(text('nope', 500), json({ late: true }))
  await assert.rejects(fetchJson(fetchFn, URL_))
  assert.equal(calls.length, 1)
})

// ---- rate limits ----

test('a short rate limit is waited out for the seconds the server asks, then the request is repeated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { fetchFn, calls } = server(rateLimited('3'), json({ done: 1 }))
  const result = fetchJson(fetchFn, URL_)
  await settle()
  t.mock.timers.tick(2999)
  await settle()
  assert.equal(calls.length, 1, 'repeated before the 3 seconds were up')
  t.mock.timers.tick(1)
  assert.deepEqual(await result, { done: 1 })
})

test('a rate limit without a waiting time backs off 1 s, then 2 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { fetchFn, calls } = server(rateLimited(), rateLimited(), json({ done: 1 }))
  const result = fetchJson(fetchFn, URL_)
  await settle()
  t.mock.timers.tick(1000)
  await settle()
  assert.equal(calls.length, 2)
  t.mock.timers.tick(1999)
  await settle()
  assert.equal(calls.length, 2, 'the second wait was shorter than 2 s')
  t.mock.timers.tick(1)
  assert.deepEqual(await result, { done: 1 })
})

test('a third rate limit in a row is reported instead of waited out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { fetchFn, calls } = server(rateLimited('1'))
  const result = fetchJson(fetchFn, URL_)
  await settle()
  t.mock.timers.tick(1000)
  await settle()
  t.mock.timers.tick(1000)
  await assert.rejects(result, { message: 'api.example.org is rate-limiting this connection; try again in 1 second' })
  assert.equal(calls.length, 3)
})

test('a rate limit longer than 5 seconds is reported at once, in seconds up to 90', async () => {
  const { fetchFn, calls } = server(rateLimited('90'))
  await assert.rejects(fetchJson(fetchFn, URL_), { message: 'api.example.org is rate-limiting this connection; try again in 90 seconds' })
  assert.equal(calls.length, 1)
})

test('a rate limit over 90 seconds is reported in whole minutes, rounded up', async () => {
  // 91 s is a minute and a second: rounded up to 2 minutes.
  const { fetchFn } = server(rateLimited('91'))
  await assert.rejects(fetchJson(fetchFn, URL_), { message: 'api.example.org is rate-limiting this connection; try again in 2 minutes' })
})

test('an unreadable Retry-After counts as not given, so the request backs off and is repeated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { fetchFn } = server(rateLimited('soon'), json({ done: 1 }))
  const result = fetchJson(fetchFn, URL_)
  await settle()
  t.mock.timers.tick(1000)
  assert.deepEqual(await result, { done: 1 })
})

test('a Retry-After date in the past counts as not given, so the request backs off 1 s and is repeated', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-26T16:00:00Z') })
  try {
    const { fetchFn } = server(rateLimited('Thu, 26 Nov 2026 15:00:00 GMT'), json({ done: 1 }))
    const result = fetchJson(fetchFn, URL_)
    await settle()
    mock.timers.tick(1000)
    assert.deepEqual(await result, { done: 1 })
  } finally {
    mock.timers.reset()
  }
})

test('a rate limit given as a date is understood as the time left until then', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-26T16:00:00Z') })
  try {
    // Ten minutes from the mocked now; HTTP allows Retry-After as a date.
    const { fetchFn } = server(rateLimited('Thu, 26 Nov 2026 16:10:00 GMT'))
    await assert.rejects(fetchJson(fetchFn, URL_), { message: 'api.example.org is rate-limiting this connection; try again in 10 minutes' })
  } finally {
    mock.timers.reset()
  }
})
