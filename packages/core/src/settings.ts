import type { Prefer, Store, Token } from './types.ts'

export interface Settings {
  prefer: Prefer
  /** Fraction, e.g. 0.005 for 0.5 %. */
  slippage: number
  /** Refuse single transfers worth more than this; null disables the limit. */
  maxUsdPerTransfer: number | null
  /** Token symbols ("USDT") or "chainKey:address" entries never to route through or into. */
  avoidTokens: string[]
  /** RPC endpoint override per chain key. */
  rpc: Record<string, string>
  /** Proxy for all API and RPC traffic, e.g. "socks5://127.0.0.1:9050" for Tor. */
  proxy: string | null
  lifi: { allowBridges: string[]; denyBridges: string[] }
}

export const defaultSettings: Settings = {
  prefer: 'cheapest',
  slippage: 0.005,
  maxUsdPerTransfer: null,
  avoidTokens: [],
  rpc: {},
  proxy: null,
  lifi: { allowBridges: [], denyBridges: [] },
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
