import { mnemonicToSeedSync } from '@scure/bip39'
import { mnemonicToAccount } from 'viem/accounts'
import { addressSlot, walletAddresses } from './derive.ts'
import type { Route } from './pipeline.ts'
import { isNative } from './tokens.ts'
import type { Chain, Store } from './types.ts'
import { addAccount, loadKeystore, newMnemonic, type AccountRecord } from './wallet.ts'

type ChainRef = Pick<Chain, 'family' | 'key'>

interface Fresh {
  chainKey: string
  mnemonic: string
  address: string
}

/**
 * Transit wallets: when a route stops on a chain where the user's wallet has no address (a
 * wallet made from one EVM private key has none on Solana or Bitcoin), the app makes a wallet
 * for that chain and the next leg is signed by it.
 *
 * Wallets for a route search are only made in memory. Nothing is stored for routes that are not
 * chosen; the ones the chosen route uses are written to the encrypted keystore by
 * persistTransit before the run starts, so funds can never arrive at a key that is not saved.
 * Transit wallets are never deleted, and an existing one for a chain is reused.
 */
export class TransitPool {
  private fresh = new Map<string, Fresh>()
  private existing: AccountRecord[]
  constructor(accounts: AccountRecord[]) {
    this.existing = accounts.filter((a) => a.transit)
  }

  addressOn(chain: ChainRef): string {
    const saved = this.existing.find((a) => a.transit!.chainKey === chain.key)
    if (saved) return saved.addresses[addressSlot(chain)]!
    let made = this.fresh.get(chain.key)
    if (!made) {
      const mnemonic = newMnemonic()
      const addresses = walletAddresses({ evm: mnemonicToAccount(mnemonic), seed: mnemonicToSeedSync(mnemonic) })
      made = { chainKey: chain.key, mnemonic, address: addresses[addressSlot(chain)]! }
      this.fresh.set(chain.key, made)
    }
    return made.address
  }

  isTransit(address: string): boolean {
    return [...this.fresh.values()].some((f) => f.address === address) || this.existing.some((a) => Object.values(a.addresses).includes(address))
  }

  /** Wallets this route would send funds through that are not yet stored. */
  pendingFor(route: Route): Fresh[] {
    const used = new Set(route.legs.flatMap((q) => [q.request.fromAddress, q.request.toAddress]))
    return [...this.fresh.values()].filter((f) => used.has(f.address))
  }

  /** Name of the stored transit wallet that owns an address, if any. */
  nameOf(address: string): string | undefined {
    return this.existing.find((a) => Object.values(a.addresses).includes(address))?.name
  }
}

/**
 * Whether a route may pass through transit wallets. What waits on a stop-over chain must either
 * be that chain's own coin, so the wallet can pay for the next leg itself, or gas must be sent
 * ahead (`gasSentAhead`, true when the gas top-up setting is on; see gastopup.ts stopOvers).
 */
export function transitAllowed(route: Route, pool: TransitPool, gasSentAhead = false): boolean {
  return gasSentAhead || route.legs.slice(0, -1).every((q) => !pool.isTransit(q.request.toAddress) || isNative(q.request.to))
}

/**
 * Writes the fresh wallets a route uses to the keystore, then returns which wallet signs from
 * which address. Must finish before anything is sent.
 */
export async function persistTransit(store: Store, pool: TransitPool, route: Route, password: () => Promise<string>): Promise<(address: string) => string | undefined> {
  for (const fresh of pool.pendingFor(route)) {
    const keystore = await loadKeystore(store)
    const taken = keystore.accounts.filter((a) => a.transit?.chainKey === fresh.chainKey).length
    const record = await addAccount(store, `transit-${fresh.chainKey}-${taken + 1}`, fresh.mnemonic, await password(), { chainKey: fresh.chainKey, createdAt: new Date().toISOString() })
    // From now on the pool treats it as stored: same address, found by name.
    pool['existing'].push(record)
    pool['fresh'].delete(fresh.chainKey)
  }
  return (address) => pool.nameOf(address)
}
