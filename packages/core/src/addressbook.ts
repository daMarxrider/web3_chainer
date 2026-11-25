import type { AddressBookEntry, Settings } from './settings.ts'

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Adds or replaces the entry for a label on a chain. The address must be valid for the chain
 * (checked by the caller's chain adapter), so a typo is caught when it is saved, not when
 * funds are sent.
 */
export function addAddress(settings: Settings, entry: AddressBookEntry, isValid: (address: string) => boolean): Settings {
  const label = entry.label.trim()
  if (!label) throw new Error('The label must not be empty')
  if (label.includes(' ') || /^0x|^[a-z0-9]{25,}$/i.test(label)) throw new Error(`"${label}" is not a good label: use a short name without spaces that cannot be mistaken for an address`)
  if (!isValid(entry.address)) throw new Error(`"${entry.address}" is not a valid address on ${entry.chainKey}`)
  const rest = settings.addressBook.filter((e) => !(sameLabel(e.label, label) && e.chainKey === entry.chainKey))
  return { ...settings, addressBook: [...rest, { ...entry, label }].sort((a, b) => a.label.localeCompare(b.label) || a.chainKey.localeCompare(b.chainKey)) }
}

export function removeAddress(settings: Settings, label: string, chainKey?: string): Settings {
  const kept = settings.addressBook.filter((e) => !(sameLabel(e.label, label) && (!chainKey || e.chainKey === chainKey)))
  if (kept.length === settings.addressBook.length) throw new Error(`No address book entry "${label}"${chainKey ? ` on ${chainKey}` : ''}`)
  return { ...settings, addressBook: kept }
}

/**
 * What the user typed after --to: a saved label becomes the address saved for the destination
 * chain; anything else is taken as an address as typed. A label with no entry for this chain is
 * an error rather than a guess.
 */
export function resolveRecipient(settings: Settings, value: string, chainKey: string): string {
  const named = settings.addressBook.filter((e) => sameLabel(e.label, value))
  if (named.length === 0) return value
  const entry = named.find((e) => e.chainKey === chainKey)
  if (!entry) throw new Error(`"${value}" is saved for ${named.map((e) => e.chainKey).join(', ')} but not for ${chainKey}`)
  return entry.address
}
