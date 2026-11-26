// Integration tests at the filesystem seam: FileUnifiedStorage and FileStorageManager exist to put
// Atomiq swap state on disk, so they are tested against a real temporary folder, removed afterwards.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FileStorageManager, FileUnifiedStorage } from '../src/providers/atomiq-storage.ts'

/** A fresh folder for one test, deleted when the test ends. */
async function folder(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chainer-atomiq-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const INDEXES = [{ key: 'state' }, { key: 'paymentHash' }]
async function unified(t: Parameters<typeof folder>[0], file = 'swaps/store.json') {
  const path = join(await folder(t), file)
  const storage = new FileUnifiedStorage(path)
  await storage.init(INDEXES)
  return { storage, path }
}
const swap = (id: string, state: number, paymentHash?: string | null) => ({ id, state, ...(paymentHash === undefined ? {} : { paymentHash }) })

// ---- unified storage: loading ----

test('a storage without a file yet starts empty', async (t) => {
  const { storage } = await unified(t)
  assert.deepEqual(await storage.query([]), [])
})

test('saved swaps are there again after a restart', async (t) => {
  const { storage, path } = await unified(t)
  await storage.save(swap('a', 1))
  const again = new FileUnifiedStorage(path)
  await again.init(INDEXES)
  assert.deepEqual(await again.query([]), [swap('a', 1)])
})

test('a damaged swap file is reported by name, never treated as empty', async (t) => {
  const path = join(await folder(t), 'store.json')
  await writeFile(path, '[{"id":"a",')
  await assert.rejects(new FileUnifiedStorage(path).init(INDEXES), new RegExp(`^Error: The swap file ${path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} is damaged and could not be read`))
})

// ---- unified storage: queries ----

test('an empty query returns every swap', async (t) => {
  const { storage } = await unified(t)
  await storage.saveAll([swap('a', 1), swap('b', 2)])
  assert.deepEqual((await storage.query([])).map((s) => s.id), ['a', 'b'])
})

test('a query with an empty condition group returns every swap', async (t) => {
  const { storage } = await unified(t)
  await storage.saveAll([swap('a', 1), swap('b', 2)])
  assert.deepEqual((await storage.query([[{ key: 'state', value: 1 }], []])).map((s) => s.id), ['a', 'b'])
})

test('conditions in one group must all hold', async (t) => {
  const { storage } = await unified(t)
  await storage.saveAll([swap('a', 1, 'h1'), swap('b', 1, 'h2'), swap('c', 2, 'h1')])
  assert.deepEqual((await storage.query([[{ key: 'state', value: 1 }, { key: 'paymentHash', value: 'h1' }]])).map((s) => s.id), ['a'])
})

test('a swap matching any one group is returned', async (t) => {
  const { storage } = await unified(t)
  await storage.saveAll([swap('a', 1), swap('b', 2), swap('c', 3)])
  assert.deepEqual((await storage.query([[{ key: 'state', value: 1 }], [{ key: 'state', value: 3 }]])).map((s) => s.id), ['a', 'c'])
})

test('a list as the value matches any of its entries', async (t) => {
  const { storage } = await unified(t)
  await storage.saveAll([swap('a', 1), swap('b', 2), swap('c', 3)])
  assert.deepEqual((await storage.query([[{ key: 'state', value: [2, 3] }]])).map((s) => s.id), ['b', 'c'])
})

test('a swap without the field never matches a condition on it', async (t) => {
  const { storage } = await unified(t)
  await storage.saveAll([swap('a', 1), swap('b', 1, null)])
  assert.deepEqual(await storage.query([[{ key: 'paymentHash', value: [null, undefined] }]]), [])
})

test('values are compared exactly, so the number 1 does not match the text "1"', async (t) => {
  const { storage } = await unified(t)
  await storage.save(swap('a', 1))
  assert.deepEqual(await storage.query([[{ key: 'state', value: '1' }]]), [])
})

test('a swap can always be found by its id', async (t) => {
  const { storage } = await unified(t)
  await storage.saveAll([swap('a', 1), swap('b', 2)])
  assert.deepEqual((await storage.query([[{ key: 'id', value: 'b' }]])).map((s) => s.id), ['b'])
})

test('a query on a field that was not declared as an index is refused, as the SDK’s own storage does', async (t) => {
  const { storage } = await unified(t)
  await assert.rejects(storage.query([[{ key: 'amount', value: 1 }]]), /^Error: Tried to query based on non-indexed column: amount!$/)
})

// ---- unified storage: changes ----

test('saving a swap again replaces it', async (t) => {
  const { storage } = await unified(t)
  await storage.save(swap('a', 1))
  await storage.save(swap('a', 2))
  assert.deepEqual(await storage.query([]), [swap('a', 2)])
})

test('a saved swap is a copy: changing the caller’s object afterwards changes nothing stored', async (t) => {
  const { storage } = await unified(t)
  const mine = swap('a', 1)
  await storage.save(mine)
  mine.state = 99
  assert.deepEqual(await storage.query([]), [swap('a', 1)])
})

test('removing a swap removes it from the file too', async (t) => {
  const { storage, path } = await unified(t)
  await storage.saveAll([swap('a', 1), swap('b', 2)])
  await storage.remove(swap('a', 1))
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [swap('b', 2)])
})

test('removing several swaps at once leaves the rest', async (t) => {
  const { storage } = await unified(t)
  await storage.saveAll([swap('a', 1), swap('b', 2), swap('c', 3)])
  await storage.removeAll([swap('a', 1), swap('c', 3)])
  assert.deepEqual((await storage.query([])).map((s) => s.id), ['b'])
})

test('many saves at the same time all end up in the file', async (t) => {
  const { storage, path } = await unified(t)
  await Promise.all([storage.save(swap('a', 1)), storage.save(swap('b', 2)), storage.save(swap('c', 3)), storage.save(swap('d', 4))])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).map((s: { id: string }) => s.id).sort(), ['a', 'b', 'c', 'd'])
})

test('after a write no temporary file is left next to the swap file', async (t) => {
  const { storage, path } = await unified(t, 'store.json')
  await storage.save(swap('a', 1))
  assert.deepEqual(await readdir(join(path, '..')), ['store.json'])
})

test('the swap file can be read by its owner only', async (t) => {
  const { storage, path } = await unified(t)
  await storage.save(swap('a', 1))
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test('a missing folder for the swap file is created, for its owner only', async (t) => {
  const { storage, path } = await unified(t, 'new/deeper/store.json')
  await storage.save(swap('a', 1))
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700)
})

// ---- storage manager ----

/** Stands in for the SDK's classes: built from saved data, serialized back to it. */
class Saved {
  value: unknown
  constructor(data: unknown) {
    this.value = data
  }
  serialize() {
    return this.value
  }
}
async function manager(t: Parameters<typeof folder>[0]) {
  const path = join(await folder(t), 'lp.json')
  return { mgr: new FileStorageManager(path), path }
}

test('a manager without a file yet loads nothing', async (t) => {
  const { mgr } = await manager(t)
  assert.deepEqual(await mgr.loadData(Saved), [])
})

test('saved objects are rebuilt from their serialized form after a restart', async (t) => {
  const { mgr, path } = await manager(t)
  await mgr.saveData('lp1', new Saved({ url: 'https://lp.example', fee: 3 }))
  const loaded = await new FileStorageManager(path).loadData(Saved)
  assert.deepEqual(loaded.map((o) => o.serialize()), [{ url: 'https://lp.example', fee: 3 }])
})

test('several objects saved at once are all kept', async (t) => {
  const { mgr, path } = await manager(t)
  await mgr.saveDataArr([{ id: 'a', object: new Saved(1) }, { id: 'b', object: new Saved(2) }])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { a: 1, b: 2 })
})

test('a removed object is gone from the file', async (t) => {
  const { mgr, path } = await manager(t)
  await mgr.saveDataArr([{ id: 'a', object: new Saved(1) }, { id: 'b', object: new Saved(2) }])
  await mgr.removeData('a')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { b: 2 })
})

test('several objects removed at once leave the rest', async (t) => {
  const { mgr, path } = await manager(t)
  await mgr.saveDataArr([{ id: 'a', object: new Saved(1) }, { id: 'b', object: new Saved(2) }, { id: 'c', object: new Saved(3) }])
  await mgr.removeDataArr(['a', 'c'])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { b: 2 })
})

test('loading replaces what the manager held before', async (t) => {
  const { mgr } = await manager(t)
  mgr.data = { stale: new Saved('old') }
  await mgr.loadData(Saved)
  assert.deepEqual(Object.keys(mgr.data), [])
})
