import { GEO_RESTRICTIONS, geoKeys, geoNotices, geoStatement, type Route } from '@chainer/core'
import { h } from '../dom.ts'
import { engine } from '../engine.ts'
import { icon } from '../icons.ts'

export interface ConfirmOptions {
  title: string
  /** Rows of the summary: label and value. */
  rows: [string, string][]
  /** The routes the run may use; any restricted service among them asks for the location confirmation. */
  routes: Route[]
  confirmLabel: string
  /** Extra text under the summary (what else will happen). */
  notes?: string[]
}

/**
 * The single confirmation before anything is signed: banner for real or test networks, a
 * summary, and the location form when a restricted service is involved. Resolves with the
 * confirmed bridge keys, or undefined when cancelled.
 */
export function confirmRun(host: HTMLElement, opts: ConfirmOptions): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const legs = opts.routes.flatMap((r) => r.legs)
    const notices = engine.testMode ? [] : geoNotices(legs)
    const keys = geoKeys(legs)
    const ok = h('input', { type: 'checkbox', id: 'confirm-geo' })
    const go = h('button', { class: 'btn primary', type: 'button', disabled: notices.length > 0 }, opts.confirmLabel)
    ok.addEventListener('change', () => (go.disabled = !ok.checked))
    let answer: string[] | undefined
    const dlg = h(
      'dialog',
      { class: 'window dialog', 'aria-labelledby': 'confirm-title' },
      h('header', { class: 'titlebar' }, h('span', { class: 'title', id: 'confirm-title' }, opts.title)),
      h(
        'div',
        { class: 'dialog-body' },
        engine.testMode ? h('p', { class: 'banner test' }, 'Test networks: this moves test funds only.') : h('p', { class: 'banner real' }, 'Real networks: this moves real money and cannot be undone.'),
        h('dl', { class: 'summary' }, opts.rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        (opts.notes ?? []).map((n) => h('p', { class: 'hint' }, n)),
        notices.length
          ? h('div', { class: 'geo' }, h('h3', {}, icon('warn'), ' Restricted services'), h('ul', {}, notices.map((n) => h('li', {}, h('strong', {}, n.name), ` is ${n.onlyIn ? 'only available in' : 'not available in'}: ${n.regions.join(', ')}. `, n.note ?? '', h('span', { class: 'via' }, ` Source: ${n.terms}`)))), h('label', { class: 'check', for: 'confirm-geo' }, ok, h('span', {}, geoStatement(notices))))
          : null,
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: () => dlg.close() }, 'Cancel'), go),
      ),
    )
    go.addEventListener('click', () => {
      answer = keys
      dlg.close()
    })
    dlg.addEventListener('close', () => {
      dlg.remove()
      resolve(answer)
    })
    host.append(dlg)
    dlg.showModal()
  })
}

/** A small dialog asking for one line of text (a name). Resolves with the text, or undefined when cancelled. */
export function askText(host: HTMLElement, title: string, label: string, placeholder = ''): Promise<string | undefined> {
  return new Promise((resolve) => {
    let answer: string | undefined
    const input = h('input', { name: 'text', id: 'ask-text', placeholder, autocomplete: 'off', required: true })
    const dlg = h(
      'dialog',
      { class: 'window dialog', 'aria-labelledby': 'ask-title' },
      h('header', { class: 'titlebar' }, h('span', { class: 'title', id: 'ask-title' }, title)),
      h(
        'form',
        { class: 'dialog-body form', method: 'dialog', onSubmit: (e: Event) => {
          e.preventDefault()
          answer = input.value.trim() || undefined
          dlg.close()
        } },
        h('label', { class: 'row', for: 'ask-text' }, h('span', { class: 'label' }, label), input),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Save')),
      ),
    )
    dlg.addEventListener('close', () => {
      dlg.remove()
      resolve(answer)
    })
    host.append(dlg)
    dlg.showModal()
    input.focus()
  })
}

/**
 * The location form for work that picks its bridges later (schedules, plans): lists every
 * restricted service that may be used and asks once. Resolves with the confirmed keys, or an
 * empty list when declined (those services are then left out), or all of them in test mode.
 */
export async function askLocation(host: HTMLElement, intro: string): Promise<string[]> {
  const usable = Object.keys(GEO_RESTRICTIONS).filter((k) => !engine.settings.lifi.denyBridges.includes(k))
  if (engine.testMode) return usable
  const notices = geoNotices(usable.map((tool) => ({ provider: 'lifi', tool })))
  if (notices.length === 0) return usable
  return new Promise((resolve) => {
    let answer: string[] = []
    const ok = h('input', { type: 'checkbox', id: 'loc-ok' })
    const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Confirm')
    ok.addEventListener('change', () => (go.disabled = !ok.checked))
    const dlg = h(
      'dialog',
      { class: 'window dialog', 'aria-labelledby': 'loc-title' },
      h('header', { class: 'titlebar' }, h('span', { class: 'title', id: 'loc-title' }, 'Confirm your location')),
      h(
        'div',
        { class: 'dialog-body' },
        h('p', { class: 'hint' }, intro),
        h('div', { class: 'geo' }, h('h3', {}, icon('warn'), ' Restricted services'), h('ul', {}, notices.map((n) => h('li', {}, h('strong', {}, n.name), ` is ${n.onlyIn ? 'only available in' : 'not available in'}: ${n.regions.join(', ')}.`))), h('label', { class: 'check', for: 'loc-ok' }, ok, h('span', {}, geoStatement(notices)))),
        h('p', { class: 'hint' }, 'If you decline, those services are simply left out.'),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: () => dlg.close() }, 'Decline'), go),
      ),
    )
    go.addEventListener('click', () => {
      answer = usable
      dlg.close()
    })
    dlg.addEventListener('close', () => {
      dlg.remove()
      resolve(answer)
    })
    host.append(dlg)
    dlg.showModal()
  })
}
