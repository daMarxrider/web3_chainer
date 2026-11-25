import { engine } from './engine.ts'

export type ThemeName = 'retro' | 'modern'

interface Prefs {
  theme: ThemeName
  /** Set once the disclaimer was accepted on first launch. */
  disclaimerAccepted: boolean
  testMode: boolean
  lastChain?: string
}

const KEY = 'ui.json'
const defaults: Prefs = { theme: 'retro', disclaimerAccepted: false, testMode: false }
let current: Prefs = defaults

export async function loadPrefs(): Promise<Prefs> {
  const raw = await engine.store.get(KEY)
  current = { ...defaults, ...(raw ? (JSON.parse(raw) as Partial<Prefs>) : {}) }
  applyTheme(current.theme)
  engine.testMode = current.testMode
  return current
}

export const prefs = (): Prefs => current

export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  current = { ...current, ...patch }
  if (patch.theme) applyTheme(patch.theme)
  if (patch.testMode !== undefined) engine.testMode = patch.testMode
  await engine.store.set(KEY, JSON.stringify(current))
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
}
