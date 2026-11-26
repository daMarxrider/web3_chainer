import type { FetchFn } from './types.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Retry-After is either seconds or an HTTP date; anything unreadable counts as not given (0). */
function retryAfterSeconds(header: string | null): number {
  if (!header) return 0
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)
  const at = Date.parse(header)
  return Number.isNaN(at) ? 0 : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/** GET/POST JSON with a clear error message and a short backoff on rate limits. */
export async function fetchJson<T>(fetchFn: FetchFn, url: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, init)
    const retryAfter = retryAfterSeconds(res.headers.get('retry-after'))
    // Short rate limits are worth waiting out; a long one is reported straight away.
    if (res.status === 429 && attempt < 2 && retryAfter <= 5) {
      await sleep(1000 * (retryAfter || 2 ** attempt))
      continue
    }
    const text = await res.text()
    if (res.status === 429) {
      const wait = retryAfter === 0 ? 'later' : retryAfter > 90 ? `in ${Math.ceil(retryAfter / 60)} minutes` : retryAfter === 1 ? 'in 1 second' : `in ${retryAfter} seconds`
      throw new Error(`${new URL(url).host} is rate-limiting this connection; try again ${wait}`)
    }
    if (!res.ok) {
      let message = text.slice(0, 300)
      try {
        message = JSON.parse(text).message ?? message
      } catch {}
      throw new Error(`${new URL(url).host} responded ${res.status}: ${message}`)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`${new URL(url).host} sent a response that is not JSON: ${text.slice(0, 300)}`)
    }
  }
}
