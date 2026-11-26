// Integration tests at the filesystem seam: fileStore is where the CLI keeps the keystore, settings
// and the transfer journal, so it is tested against a real temporary folder, removed afterwards.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeRoute, loadRoute } from '@chainer/core'
import { dataDir, fetchWithTimeout, fileStore } from '../src/env.ts'

async function folder(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chainer-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// ---- reading and writing ----

test('a key that was never written reads as nothing', async (t) => {
  assert.equal(await fileStore(await folder(t)).get('settings.json'), null)
})

test('a written value reads back the same', async (t) => {
  const store = fileStore(await folder(t))
  await store.set('settings.json', '{"slippage":0.01}')
  assert.equal(await store.get('settings.json'), '{"slippage":0.01}')
})

test('writing a key again replaces its value', async (t) => {
  const store = fileStore(await folder(t))
  await store.set('settings.json', 'old')
  await store.set('settings.json', 'new')
  assert.equal(await store.get('settings.json'), 'new')
})

test('a key with a folder in it creates the folder, for its owner only', async (t) => {
  const dir = await folder(t)
  await fileStore(dir).set('runs/abc.json', '{}')
  assert.equal((await stat(join(dir, 'runs'))).mode & 0o777, 0o700)
})

test('a written file can be read by its owner only', async (t) => {
  const dir = await folder(t)
  await fileStore(dir).set('keystore.json', '{}')
  assert.equal((await stat(join(dir, 'keystore.json'))).mode & 0o777, 0o600)
})

test('after a write no temporary file is left behind', async (t) => {
  const dir = await folder(t)
  await fileStore(dir).set('keystore.json', '{}')
  assert.deepEqual(await readdir(dir), ['keystore.json'])
})

test('a key that is a folder cannot be read as a file, and says so', async (t) => {
  const dir = await folder(t)
  await fileStore(dir).set('runs/a.json', '{}')
  await assert.rejects(fileStore(dir).get('runs'), { code: 'EISDIR' })
})

// ---- listing ----

test('the keys under a folder are listed with the folder in front', async (t) => {
  const store = fileStore(await folder(t))
  await store.set('runs/a.json', '{}')
  await store.set('runs/b.json', '{}')
  assert.deepEqual((await store.keys('runs/')).sort(), ['runs/a.json', 'runs/b.json'])
})

test('a folder that does not exist yet lists no keys', async (t) => {
  assert.deepEqual(await fileStore(await folder(t)).keys('runs/'), [])
})

test('a temporary file left by a crash mid-write is not listed', async (t) => {
  const dir = await folder(t)
  const store = fileStore(dir)
  await store.set('runs/a.json', '{}')
  await writeFile(join(dir, 'runs', 'b.json.tmp'), '{"half')
  assert.deepEqual(await store.keys('runs/'), ['runs/a.json'])
})

// ---- staying inside the data folder ----

test('a key that climbs out of the data folder is refused for writing', async (t) => {
  const dir = await folder(t)
  await assert.rejects(fileStore(join(dir, 'data')).set('../outside.json', 'x'), /^Error: Refusing to use "\.\.\/outside\.json": it is outside the data folder$/)
})

test('a key that climbs out of the data folder is refused for reading', async (t) => {
  const dir = await folder(t)
  await assert.rejects(fileStore(join(dir, 'data')).get('../outside.json'), /outside the data folder/)
})

test('an absolute path as a key is refused', async (t) => {
  await assert.rejects(fileStore(await folder(t)).get('/etc/passwd'), /outside the data folder/)
})

test('a key that climbs out and back in stays allowed', async (t) => {
  const store = fileStore(await folder(t))
  await store.set('runs/../settings.json', 'ok')
  assert.equal(await store.get('settings.json'), 'ok')
})

test('removing a saved route named "../keystore" leaves the wallet file untouched', async (t) => {
  const dir = await folder(t)
  const store = fileStore(dir)
  await store.set('keystore.json', '{"version":1,"accounts":["encrypted"]}')
  await assert.rejects(removeRoute(store, '../keystore'), /^Error: No saved route "\.\.\/keystore"$/)
  assert.equal(await readFile(join(dir, 'keystore.json'), 'utf8'), '{"version":1,"accounts":["encrypted"]}')
})

test('a saved route named "../settings" is not loaded from outside the routes folder', async (t) => {
  const store = fileStore(await folder(t))
  await store.set('settings.json', '{"kind":"transfer","name":"x"}')
  await assert.rejects(loadRoute(store, '../settings'), /^Error: No saved route "\.\.\/settings"/)
})

// ---- where the data lives ----

/** Runs fn with environment variables set as given (undefined removes one), then restores them. */
function withEnv(vars: Record<string, string | undefined>, fn: () => string): string {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  const apply = (v: Record<string, string | undefined>) => Object.entries(v).forEach(([k, x]) => (x === undefined ? delete process.env[k] : (process.env[k] = x)))
  apply(vars)
  try {
    return fn()
  } finally {
    apply(saved)
  }
}

test('CHAINER_HOME decides where the data lives, over everything else', () => {
  assert.equal(withEnv({ CHAINER_HOME: '/tmp/test-home', XDG_CONFIG_HOME: '/xdg' }, dataDir), '/tmp/test-home')
})

test('without CHAINER_HOME the data lives in XDG_CONFIG_HOME/chainer', () => {
  assert.equal(withEnv({ CHAINER_HOME: undefined, XDG_CONFIG_HOME: '/xdg' }, dataDir), '/xdg/chainer')
})

test('without either, the data lives in ~/.config/chainer', () => {
  assert.equal(withEnv({ CHAINER_HOME: undefined, XDG_CONFIG_HOME: undefined, HOME: '/home/someone' }, dataDir), '/home/someone/.config/chainer')
})

// ---- more of the store, and the timeout on requests ----

test('listing under a key that is a file, not a folder, is an error, not an empty list', async (t) => {
  const store = fileStore(await folder(t))
  await store.set('runs', 'not a folder')
  await assert.rejects(store.keys('runs/'), { code: 'ENOTDIR' })
})

test('a request without a signal of its own gets one that times out', async (t) => {
  let seen: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => ((seen = init?.signal ?? undefined), new Response('{}')))
  await fetchWithTimeout('https://example.org', {})
  assert.equal(seen instanceof AbortSignal, true)
})

test('a request’s own signal is kept', async (t) => {
  let seen: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => ((seen = init?.signal ?? undefined), new Response('{}')))
  const mine = new AbortController().signal
  await fetchWithTimeout('https://example.org', { signal: mine })
  assert.equal(seen, mine)
})
