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

/**
 * Gives every cell of a `table.data` its column's heading as `data-label`, so on a phone, where
 * each row is shown as a stack of "heading: value" lines, a value keeps its name. Watches `root`
 * because screens fill tables in after they are attached.
 */
export function labelTableCells(root: HTMLElement): void {
  const label = () => {
    for (const table of root.querySelectorAll<HTMLTableElement>('table.data')) {
      const heads = table.tHead?.rows[0]
      if (!heads) continue
      const names: string[] = []
      for (const th of heads.cells) for (let i = 0; i < th.colSpan; i++) names.push(th.textContent?.trim() ?? '')
      for (const body of [...table.tBodies, table.tFoot].filter((b): b is HTMLTableSectionElement => b !== null)) {
        for (const row of body.rows) {
          let col = 0
          for (const cell of row.cells) {
            if (!cell.hasAttribute('data-label')) cell.dataset.label = cell.colSpan > 1 ? '' : (names[col] ?? '')
            col += cell.colSpan
          }
        }
      }
    }
  }
  new MutationObserver(label).observe(root, { childList: true, subtree: true })
}

/**
 * Opens a modal dialog as a step of its own in the history, so the back button (Android's, or the
 * browser's) closes it. Closing it any other way takes that step out again. Call it from a tap or
 * key press: a history step added without one is skipped by the back button.
 */
export function showDialog(dlg: HTMLDialogElement): void {
  dlg.showModal()
  history.pushState({ ...(history.state as object | null), dialog: true }, '')
  dlg.addEventListener(
    'close',
    () => {
      if ((history.state as { dialog?: boolean } | null)?.dialog) {
        ignoredPops++
        history.back()
      }
    },
    { once: true },
  )
}

/** Back steps taken by `showDialog` itself, which the back handler must not act on. */
let ignoredPops = 0
/** Whether the history step being handled now is one of those. */
let currentPopIsOwn = false
// Registered when this module loads, so it runs before any screen's back handler.
addEventListener('popstate', () => {
  currentPopIsOwn = ignoredPops > 0
  if (currentPopIsOwn) ignoredPops--
})

/** True while handling a history step that a dialog closed by itself took out; a back handler then does nothing. */
export const ownPop = (): boolean => currentPopIsOwn

/**
 * Closes a dialog opened with `showDialog` and resolves once the history step it took out is gone,
 * so a step added next (opening a screen) cannot be lost to it. The close event, and with it that
 * step, comes a moment after `close()`.
 */
export function closeDialog(dlg: HTMLDialogElement): Promise<void> {
  return new Promise((done) => {
    // Runs after showDialog's own close listener, which was added first.
    dlg.addEventListener(
      'close',
      () => {
        if (ignoredPops === 0) return done()
        addEventListener('popstate', () => done(), { once: true })
      },
      { once: true },
    )
    dlg.close()
  })
}
