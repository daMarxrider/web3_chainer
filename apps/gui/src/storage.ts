import type { Store } from '@chainer/core'

/** localStorage with the same shape as the CLI's file store; used by the browser build. */
export function localStore(prefix = 'chainer/'): Store & { remove(key: string): void } {
  const all = () => Object.keys(localStorage).filter((k) => k.startsWith(prefix))
  return {
    async get(key) {
      return localStorage.getItem(prefix + key)
    },
    async set(key, value) {
      localStorage.setItem(prefix + key, value)
    },
    async keys(p) {
      return all()
        .map((k) => k.slice(prefix.length))
        .filter((k) => k.startsWith(p))
    },
    remove(key) {
      localStorage.removeItem(prefix + key)
    },
  }
}

type Invoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>

/**
 * The desktop app's store: files in the same data folder as the command line (see `store.rs` in
 * src-tauri), so both use one wallet. Same keys and layout as the CLI's `fileStore`.
 */
export function tauriStore(invoke: Invoke): Store {
  return {
    get: (key) => invoke<string | null>('store_get', { key }),
    set: (key, value) => invoke<void>('store_set', { key, value }),
    keys: (prefix) => invoke<string[]>('store_keys', { prefix }),
  }
}

/** Where a webview copy goes when the data folder already holds a different file under the same key. */
export const BACKUP_PREFIX = 'webview-backup/'

/**
 * Moves what earlier desktop versions kept in the webview's local storage into the data folder,
 * once. A key the folder does not have is copied; one it has with the same content is dropped; one
 * it has with different content keeps the folder's file and puts the webview copy under
 * `webview-backup/`, so nothing is lost (two keystores cannot be merged: each has its own salt).
 * The webview copy of a key is removed only after it was written. Returns the keys that conflicted.
 */
export async function moveWebviewData(from: Store & { remove(key: string): void }, to: Store): Promise<string[]> {
  const conflicts: string[] = []
  for (const key of await from.keys('')) {
    const value = (await from.get(key))!
    const there = await to.get(key)
    if (there === null) await to.set(key, value)
    else if (there !== value) {
      await to.set(BACKUP_PREFIX + key, value)
      conflicts.push(key)
    }
    from.remove(key)
  }
  return conflicts
}
