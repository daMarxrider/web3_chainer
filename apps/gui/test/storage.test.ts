import assert from 'node:assert/strict'
import { test } from 'node:test'
import { moveWebviewData } from '../src/storage.ts'

/** A store over a Map, standing in for local storage (from) and the data folder (to). */
function mapStore(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries))
  return {
    map,
    async get(key: string) {
      return map.get(key) ?? null
    },
    async set(key: string, value: string) {
      map.set(key, value)
    },
    async keys(prefix: string) {
      return [...map.keys()].filter((k) => k.startsWith(prefix))
    },
    remove(key: string) {
      map.delete(key)
    },
  }
}

test('keys the data folder lacks are copied and leave the webview', async () => {
  const from = mapStore({ 'keystore.json': 'K', 'transfers/a.json': 'T' })
  const to = mapStore()
  assert.deepEqual(await moveWebviewData(from, to), [])
  assert.deepEqual(Object.fromEntries(to.map), { 'keystore.json': 'K', 'transfers/a.json': 'T' })
  assert.equal(from.map.size, 0)
})

test('a key the folder holds with the same content is dropped from the webview without a backup', async () => {
  const from = mapStore({ 'settings.json': 'S' })
  const to = mapStore({ 'settings.json': 'S' })
  assert.deepEqual(await moveWebviewData(from, to), [])
  assert.deepEqual(Object.fromEntries(to.map), { 'settings.json': 'S' })
  assert.equal(from.map.size, 0)
})

test('a different keystore in the folder is kept and the webview one is backed up and reported', async () => {
  const from = mapStore({ 'keystore.json': 'desktop wallet' })
  const to = mapStore({ 'keystore.json': 'cli wallet' })
  assert.deepEqual(await moveWebviewData(from, to), ['keystore.json'])
  assert.deepEqual(Object.fromEntries(to.map), { 'keystore.json': 'cli wallet', 'webview-backup/keystore.json': 'desktop wallet' })
  assert.equal(from.map.size, 0)
})

test('a key whose write fails stays in the webview', async () => {
  const from = mapStore({ 'keystore.json': 'K' })
  const to = { ...mapStore(), set: async () => { throw new Error('disk full') } }
  await assert.rejects(moveWebviewData(from, to), /disk full/)
  assert.equal(from.map.get('keystore.json'), 'K')
})

test('a second run with nothing left in the webview changes nothing', async () => {
  const from = mapStore({ 'ui.json': 'U' })
  const to = mapStore()
  await moveWebviewData(from, to)
  assert.deepEqual(await moveWebviewData(from, to), [])
  assert.deepEqual(Object.fromEntries(to.map), { 'ui.json': 'U' })
})
