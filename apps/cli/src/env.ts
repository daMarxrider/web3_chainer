import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FetchFn, Store } from '@chainer/core'

/** Where settings, the encrypted keystore and the transfer journal live. */
export function dataDir(): string {
  if (process.env.CHAINER_HOME) return process.env.CHAINER_HOME
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'chainer')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'chainer')
}

export function fileStore(dir: string): Store {
  /** The file for a key; a key that would lead outside the data folder (../, an absolute path) is refused. */
  const pathOf = (key: string) => {
    const path = resolve(dir, key)
    const inside = relative(resolve(dir), path)
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`Refusing to use "${key}": it is outside the data folder`)
    return path
  }
  return {
    async get(key) {
      const path = pathOf(key)
      try {
        return await readFile(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    async set(key, value) {
      const path = pathOf(key)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      // Write-then-rename so a crash mid-write cannot corrupt the keystore or journal.
      await writeFile(`${path}.tmp`, value, { mode: 0o600 })
      await rename(`${path}.tmp`, path)
    },
    async keys(prefix) {
      try {
        const names = await readdir(pathOf(prefix))
        return names.filter((n) => !n.endsWith('.tmp')).map((n) => `${prefix}${n}`)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
    },
  }
}

/** fetch with a timeout, so a hanging server cannot stall a run forever. */
export const fetchWithTimeout: FetchFn = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) })
