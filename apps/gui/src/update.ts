/** The repository whose GitHub releases the app checks for a newer version. */
export const REPO = 'daMarxrider/web3_chainer'
export const RELEASES_URL = `https://github.com/${REPO}/releases`

/** Parses "1.2.3" or "v1.2.3" into its three numbers; anything else (a pre-release, a stray tag) gives null. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True when `latest` is a later version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) throw new Error(`Cannot compare versions "${latest}" and "${current}"`)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

export type UpdateCheck = { newer: false } | { newer: true; version: string; url: string }

/**
 * Asks GitHub for the latest published release (drafts and pre-releases are not returned) and
 * compares it with the running version. Throws on a network or GitHub error, so the caller can say
 * the check failed instead of claiming the app is up to date.
 */
export async function checkForUpdate(current: string, fetcher: typeof fetch): Promise<UpdateCheck> {
  const res = await fetcher(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
  if (typeof body.tag_name !== 'string') throw new Error('GitHub sent no version')
  const version = body.tag_name.replace(/^v/, '')
  if (!isNewer(version, current)) return { newer: false }
  return { newer: true, version, url: typeof body.html_url === 'string' ? body.html_url : RELEASES_URL }
}
