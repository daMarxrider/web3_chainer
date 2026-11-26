import { formatUnits } from '@chainer/core'
import type { Token } from '@chainer/core'

type Child = Node | string | number | false | null | undefined
type Props = { [key: string]: unknown }

/** Builds an element. `on*` props become listeners; `class` and `dataset` are handled; true attributes are set empty. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = String(value)
    else if (key === 'dataset') Object.assign(el.dataset, value as object)
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    else if (value === true) el.setAttribute(key, '')
    else el.setAttribute(key, String(value))
  }
  append(el, children.flat())
  return el
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
  }
}

export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren()
  append(el, children)
}

/** A dollar value with two decimals and thousands grouped, like token amounts. */
export const usd = (n: number | undefined) =>
  n === undefined ? '?' : n < 0.01 && n > 0 ? '<$0.01' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** An amount in a token's units, trimmed to what is readable. */
export function amount(raw: bigint | string, token: Pick<Token, 'decimals'>, maxDecimals = 6): string {
  const value = BigInt(raw)
  const [whole = '0', frac = ''] = formatUnits(value, token.decimals).split('.')
  const shown = frac.slice(0, maxDecimals).replace(/0+$/, '')
  // Something held, but too little to show: say so instead of printing 0.
  if (value > 0n && whole === '0' && !shown) return maxDecimals > 0 ? `<0.${'0'.repeat(maxDecimals - 1)}1` : '<1'
  // BigInt, not Number: a whole part beyond 2^53 would lose its last digits.
  const w = BigInt(whole).toLocaleString('en-US')
  return shown ? `${w}.${shown}` : w
}

export function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

export const shortAddress = (a: string) => (a.length > 18 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a)

/** Reads a named form control, failing clearly when it is missing. */
export function field<T extends HTMLElement>(root: ParentNode, name: string): T {
  const el = root.querySelector<T>(`[name="${name}"]`)
  if (!el) throw new Error(`Missing field ${name}`)
  return el
}
