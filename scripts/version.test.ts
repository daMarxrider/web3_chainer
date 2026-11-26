import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mismatches, nextVersion } from './version.ts'

test('every file carries the same version as the root package.json', () => {
  assert.deepEqual(mismatches(), [])
})

test('bumps follow the rules: fix = patch, feature = minor, break = major (also on 0.x)', () => {
  assert.equal(nextVersion('0.4.2', 'patch'), '0.4.3')
  assert.equal(nextVersion('0.4.2', 'minor'), '0.5.0')
  assert.equal(nextVersion('0.4.2', 'major'), '1.0.0')
  assert.equal(nextVersion('1.9.9', 'minor'), '1.10.0')
  assert.equal(nextVersion('0.9.3', '1.0.0'), '1.0.0')
})

test('a version that is not above the current one, or not X.Y.Z, is refused', () => {
  assert.throws(() => nextVersion('0.4.2', '0.4.2'), /not above/)
  assert.throws(() => nextVersion('0.4.2', '0.3.9'), /not above/)
  assert.throws(() => nextVersion('0.4.2', 'v0.5.0'), /Unknown bump/)
  assert.throws(() => nextVersion('0.4', 'patch'), /not a MAJOR/)
})
