import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkForUpdate, isNewer } from '../src/update.ts'

test('a higher patch, minor or major is newer', () => {
  assert.equal(isNewer('0.2.2', '0.2.1'), true)
  assert.equal(isNewer('0.3.0', '0.2.9'), true)
  assert.equal(isNewer('v1.0.0', '0.9.9'), true)
})

test('the same or an older version is not newer', () => {
  assert.equal(isNewer('0.2.1', '0.2.1'), false)
  assert.equal(isNewer('0.2.0', '0.2.1'), false)
  // compared as numbers, not text: 0.10.0 is after 0.9.0
  assert.equal(isNewer('0.9.0', '0.10.0'), false)
})

test('a tag that is not a version is refused, not read as up to date', () => {
  assert.throws(() => isNewer('nightly', '0.2.1'))
})

const answer = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status })

test('the latest release is offered when it is newer', async () => {
  const r = await checkForUpdate('0.2.1', answer(200, { tag_name: 'v0.3.0', html_url: 'https://github.com/x/y/releases/tag/v0.3.0' }))
  assert.deepEqual(r, { newer: true, version: '0.3.0', url: 'https://github.com/x/y/releases/tag/v0.3.0' })
})

test('the running version being the latest is reported as up to date', async () => {
  assert.deepEqual(await checkForUpdate('0.2.1', answer(200, { tag_name: 'v0.2.1' })), { newer: false })
})

test('a GitHub error fails the check', async () => {
  await assert.rejects(checkForUpdate('0.2.1', answer(403, { message: 'rate limited' })), /403/)
})
