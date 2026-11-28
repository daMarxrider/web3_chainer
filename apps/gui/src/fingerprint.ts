import { invoke } from '@tauri-apps/api/core'

/**
 * Fingerprint unlock, Android only (FingerprintPlugin.kt): the wallet password is kept encrypted
 * under a key that only a fingerprint opens. On by default: a password unlock turns it on, unless
 * the owner turned it off or a newly added fingerprint did. Elsewhere `status` reports it unavailable.
 */
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Why a prompt ended without a password: the user chose the password, the key is gone, etc. */
export type Outcome = { ok: true } | { ok: false; reason: 'cancelled' | 'invalidated' | 'unavailable' | 'off' | 'error'; message?: string }

const call = <T>(command: string, args: Record<string, unknown>) => invoke<T>('fingerprint', { command, args })

/** Whether this device can use a fingerprint, whether it is on for `wallet`, and whether it was turned off (so it stays off). */
export async function fingerprintStatus(wallet: string): Promise<{ available: boolean; enabled: boolean; off: boolean }> {
  if (!inTauri) return { available: false, enabled: false, off: false }
  return call('status', { wallet })
}

/** Stores `password` for `wallet` under a new key; needs no fingerprint. */
export const enableFingerprint = (wallet: string, password: string) => call<Outcome>('enable', { wallet, password })

/** Asks for a fingerprint and gives back `wallet`'s password. */
export const fingerprintPassword = (wallet: string) => call<Outcome & { password?: string }>('unlock', { wallet })

/** Forgets the stored password and its key, and keeps it off until turned on again. */
export const disableFingerprint = (wallet: string) => call<Outcome>('disable', { wallet })

/**
 * The default: after the password opened `wallet`, turns fingerprint unlock on if the device can
 * and it was not turned off. A failure only means the next unlock asks for the password again, so
 * it is logged rather than shown.
 */
export async function fingerprintByDefault(wallet: string, password: string): Promise<void> {
  try {
    const s = await fingerprintStatus(wallet)
    if (s.available && !s.enabled && !s.off) await enableFingerprint(wallet, password)
  } catch (err) {
    console.warn('Fingerprint unlock could not be turned on:', err)
  }
}
