import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addAddress, defaultSettings, removeAddress, resolveRecipient } from '../src/index.ts'

const ok = () => true
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

test('entries are kept per label and chain, and replaced when saved again', () => {
  let s = addAddress(defaultSettings, { label: 'cold', chainKey: 'eth', address: A }, ok)
  s = addAddress(s, { label: 'Cold', chainKey: 'bas', address: B }, ok)
  s = addAddress(s, { label: 'cold', chainKey: 'eth', address: B }, ok)
  assert.deepEqual(s.addressBook.map((e) => [e.label, e.chainKey, e.address]), [['cold', 'eth', B], ['Cold', 'bas', B]])
})

test('an invalid address or a label that looks like an address is refused', () => {
  assert.throws(() => addAddress(defaultSettings, { label: 'x', chainKey: 'eth', address: 'nope' }, () => false), /not a valid address/)
  assert.throws(() => addAddress(defaultSettings, { label: A, chainKey: 'eth', address: A }, ok), /not a good label/)
  assert.throws(() => addAddress(defaultSettings, { label: 'my wallet', chainKey: 'eth', address: A }, ok), /not a good label/)
})

test('--to resolves labels for the destination chain and leaves real addresses alone', () => {
  const s = addAddress(addAddress(defaultSettings, { label: 'cold', chainKey: 'eth', address: A }, ok), { label: 'cold', chainKey: 'bas', address: B }, ok)
  assert.equal(resolveRecipient(s, 'cold', 'bas'), B)
  assert.equal(resolveRecipient(s, 'COLD', 'eth'), A)
  assert.equal(resolveRecipient(s, A, 'bas'), A)
  assert.throws(() => resolveRecipient(s, 'cold', 'arb'), /saved for bas, eth but not for arb/)
})

test('removing needs an existing entry; without a chain it removes the label everywhere', () => {
  const s = addAddress(addAddress(defaultSettings, { label: 'cold', chainKey: 'eth', address: A }, ok), { label: 'cold', chainKey: 'bas', address: B }, ok)
  assert.equal(removeAddress(s, 'cold', 'eth').addressBook.length, 1)
  assert.equal(removeAddress(s, 'cold').addressBook.length, 0)
  assert.throws(() => removeAddress(s, 'other'), /No address book entry/)
})
