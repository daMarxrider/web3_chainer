import type { FetchFn } from './types.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** GET/POST JSON with a clear error message and a short backoff on rate limits. */
export async function fetchJson<T>(fetchFn: FetchFn, url: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, init)
    if (res.status === 429 && attempt < 3) {
      await sleep(1000 * 2 ** attempt)
      continue
    }
    const text = await res.text()
    if (!res.ok) {
      let message = text.slice(0, 300)
      try {
        message = JSON.parse(text).message ?? message
      } catch {}
      throw new Error(`${new URL(url).host} responded ${res.status}: ${message}`)
    }
    return JSON.parse(text) as T
  }
}
