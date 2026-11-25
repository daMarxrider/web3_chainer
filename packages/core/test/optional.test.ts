import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSdk, sdkStatus } from '../src/index.ts'

const missing = (pkg: string) => Object.assign(new Error(`Cannot find package '${pkg}' imported from x`), { code: 'ERR_MODULE_NOT_FOUND' })

test('a missing SDK gives undefined, not an error', async () => {
  assert.equal(await loadSdk('@atomiqlabs/sdk', async (p) => { throw missing(p) }), undefined)
})

test('an installed SDK is returned', async () => {
  const mod = { hello: 1 }
  assert.equal(await loadSdk('@atomiqlabs/sdk', async () => mod), mod)
})

test('a broken install is reported, not hidden as "not installed"', async () => {
  await assert.rejects(loadSdk('@atomiqlabs/sdk', async () => { throw new Error('boom') }), /installed but could not be loaded: boom/)
  // a different package missing inside the SDK is also a broken install
  await assert.rejects(loadSdk('@atomiqlabs/sdk', async () => { throw missing('@atomiqlabs/base') }), /could not be loaded/)
})

test('status lists each SDK with whether it is installed', async () => {
  const status = await sdkStatus(async (p) => { throw missing(p) })
  assert.deepEqual(status.map((s) => [s.provider, s.installed, s.error]), [['atomiq', false, undefined]])
})
