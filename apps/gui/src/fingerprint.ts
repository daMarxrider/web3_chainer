import { invoke } from '@tauri-apps/api/core'

/**
 * Fingerprint unlock, Android only (FingerprintPlugin.kt): the wallet password is kept encrypted
 * under a key that only a fingerprint opens. Elsewhere `status` reports it unavailable.
 */
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Why a prompt ended without a password: the user chose the password, the key is gone, etc. */
export type Outcome = { ok: true } | { ok: false; reason: 'cancelled' | 'invalidated' | 'unavailable' | 'off' | 'error'; message?: string }

const call = <T>(command: string, args: Record<string, unknown>) => invoke<T>('fingerprint', { command, args })

/** Whether this device can use a fingerprint, and whether it is turned on for `wallet`. */
export async function fingerprintStatus(wallet: string): Promise<{ available: boolean; enabled: boolean }> {
  if (!inTauri) return { available: false, enabled: false }
  return call('status', { wallet })
}

/** Asks for a fingerprint and stores `password` for `wallet` under it. */
export const enableFingerprint = (wallet: string, password: string) => call<Outcome>('enable', { wallet, password })

/** Asks for a fingerprint and gives back `wallet`'s password. */
export const fingerprintPassword = (wallet: string) => call<Outcome & { password?: string }>('unlock', { wallet })

/** Forgets the stored password and its key. */
export const disableFingerprint = (wallet: string) => call<Outcome>('disable', { wallet })
