import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { FetchFn, Store } from '@chainer/core'

/** Where settings, the encrypted keystore and the transfer journal live. */
export function dataDir(): string {
  if (process.env.CHAINER_HOME) return process.env.CHAINER_HOME
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'chainer')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'chainer')
}

export function fileStore(dir: string): Store {
  return {
    async get(key) {
      try {
        return await readFile(join(dir, key), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    async set(key, value) {
      const path = join(dir, key)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      // Write-then-rename so a crash mid-write cannot corrupt the keystore or journal.
      await writeFile(`${path}.tmp`, value, { mode: 0o600 })
      await rename(`${path}.tmp`, path)
    },
    async keys(prefix) {
      try {
        const names = await readdir(join(dir, prefix))
        return names.filter((n) => !n.endsWith('.tmp')).map((n) => `${prefix}${n}`)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
    },
  }
}

/** fetch with a timeout; when a proxy is set, every request goes through it (SOCKS5 for Tor, or HTTP). */
export function makeFetch(proxy: string | null): FetchFn {
  const timeout = (init?: RequestInit) => ({ ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) })
  if (!proxy) return (input, init) => fetch(input, timeout(init))
  // undici prints an "experimental" warning for SOCKS5 on every start; it is not useful to the user.
  const emitWarning = process.emitWarning
  process.emitWarning = () => {}
  const dispatcher = new ProxyAgent(proxy)
  process.emitWarning = emitWarning
  return ((input: string | URL, init?: RequestInit) => undiciFetch(input, { ...timeout(init), dispatcher } as never)) as unknown as FetchFn
}
