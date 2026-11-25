import { DEFAULT_DENIED_BRIDGES } from './geo.ts'
import type { Prefer, Store, Token } from './types.ts'

export interface Settings {
  prefer: Prefer
  /** Fraction, e.g. 0.005 for 0.5 %. */
  slippage: number
  /** Refuse single transfers worth more than this; null disables the limit. */
  maxUsdPerTransfer: number | null
  /** Most legs an automatically found route may have. */
  maxHops: number
  /** Token symbols ("USDT") or "chainKey:address" entries never to route through or into. */
  avoidTokens: string[]
  /** RPC endpoint override per chain key. */
  rpc: Record<string, string>
  lifi: { allowBridges: string[]; denyBridges: string[] }
  /** Route sources switched off by name ("thorchain", "maya"). LI.FI is always on. */
  disabledProviders: string[]
  /** Use BlockCypher (Dogecoin, Dash) whose docs ask for an API token on broadcasts. Off until the user turns it on. */
  blockcypher: boolean
  /** Named recipient addresses; each is tied to the chain it was checked against. */
  addressBook: AddressBookEntry[]
}

export interface AddressBookEntry {
  label: string
  chainKey: string
  address: string
}

export const defaultSettings: Settings = {
  prefer: 'cheapest',
  slippage: 0.005,
  maxUsdPerTransfer: null,
  maxHops: 3,
  avoidTokens: [],
  rpc: {},
  lifi: { allowBridges: [], denyBridges: [...DEFAULT_DENIED_BRIDGES] },
  disabledProviders: [],
  blockcypher: false,
  addressBook: [],
}

const KEY = 'settings.json'

export async function loadSettings(store: Store): Promise<Settings> {
  const raw = await store.get(KEY)
  const saved = raw ? (JSON.parse(raw) as Partial<Settings>) : {}
  return { ...defaultSettings, ...saved, lifi: { ...defaultSettings.lifi, ...saved.lifi } }
}

export async function saveSettings(store: Store, settings: Settings): Promise<void> {
  await store.set(KEY, JSON.stringify(settings, null, 2))
}

export function isAvoided(settings: Settings, token: Pick<Token, 'symbol' | 'chainKey' | 'address'>): boolean {
  const symbol = token.symbol.toLowerCase()
  const id = `${token.chainKey}:${token.address}`.toLowerCase()
  return settings.avoidTokens.some((entry) => {
    const e = entry.toLowerCase()
    return e === symbol || e === id
  })
}

export function isSymbolAvoided(settings: Settings, symbol: string): boolean {
  return settings.avoidTokens.some((entry) => entry.toLowerCase() === symbol.toLowerCase())
}
