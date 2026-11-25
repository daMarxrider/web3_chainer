import { routeEta, routeNetUsd, type Chain, type SweepPlan, type Token } from '@chainer/core'
import { amount, duration, h, replace, usd } from '../dom.ts'
import { engine } from '../engine.ts'
import { askText, confirmRun } from './confirm.ts'
import { showJobs } from './job.ts'

const via = (r: { legs: { provider: string; tool: string }[] }) => r.legs.map((q) => `${q.provider}/${q.tool}`).join(' > ')

/** Shows a planned sweep and, once confirmed, runs one transfer per token. Used by this screen and by saved sweeps. */
export async function reviewAndRunSweep(sheet: HTMLElement, plan: SweepPlan, toAddress: string, fromChain: Chain, toChain: Chain, back: () => void): Promise<void> {
  if (plan.items.length === 0) {
    replace(sheet, h('h1', { class: 'sheet-title' }, 'Bridge wallet'), h('p', { class: 'empty' }, 'Nothing to send.'), skippedList(plan), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: back }, 'Back')))
    return
  }
  const accepted = await confirmRun(sheet, {
    title: 'Confirm sweep',
    rows: [
      ['From', fromChain.name],
      ['To', `${toChain.name}, ${toAddress}`],
      ['Transfers', `${plan.items.length}, one after the other`],
      ...plan.items.map((i): [string, string] => [i.from.symbol, `${amount(i.amount, i.from)} to ${amount(i.route.legs.at(-1)!.toAmount, i.to)} ${i.to.symbol} via ${via(i.route)}`]),
    ],
    routes: plan.items.map((i) => i.route),
    confirmLabel: 'Send all',
    notes: plan.skipped.length ? [`${plan.skipped.length} token${plan.skipped.length === 1 ? ' is' : 's are'} skipped (see the plan).`] : [],
  })
  if (!accepted) return
  const name = (key: string) => (key === fromChain.key ? fromChain.name : key === toChain.key ? toChain.name : key)
  await showJobs(sheet, 'Bridge wallet in progress', name, plan.items.map((i) => ({ label: i.from.symbol, run: (onEvent) => engine.run(i.route, accepted, onEvent) })), back)
}

function skippedList(plan: SweepPlan): HTMLElement {
  return plan.skipped.length === 0 ? h('span', {}) : h('div', {}, h('h2', {}, 'Skipped'), h('ul', {}, plan.skipped.map((s) => h('li', {}, h('strong', {}, s.token.symbol), `: ${s.reason}`))))
}

/** Whole-wallet bridging: pick a chain pair and tokens, review the plan, send one transfer per token. */
export async function sweepScreen(sheet: HTMLElement): Promise<void> {
  const chains = await engine.pickerChains()
  const chainSelect = (name: string, value: string | undefined) => h('select', { name, id: `sw-${name}` }, chains.map((c) => h('option', { value: c.key, selected: c.key === value }, c.name)))
  const from = chainSelect('from', chains.find((c) => c.key === (engine.testMode ? 'arct' : 'arb'))?.key)
  const to = chainSelect('to', chains.find((c) => c.key === (engine.testMode ? 'bast' : 'bas'))?.key)
  const target = h('input', { name: 'target', id: 'sw-target', placeholder: 'same token on the destination', autocomplete: 'off' })
  const recipient = h('input', { name: 'recipient', id: 'sw-recipient', placeholder: 'your own address, or an address book label', autocomplete: 'off', spellcheck: 'false' })
  const err = h('p', { class: 'form-error', role: 'alert' })
  const held = h('div', { class: 'table-wrap' })
  const result = h('section', { class: 'results', 'aria-live': 'polite' })
  const find = h('button', { class: 'btn', type: 'button' }, 'Show tokens')
  const plan = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Plan the sweep')
  let tokens: { token: Token; balance: bigint; usd?: number }[] = []
  const checks = new Map<string, HTMLInputElement>()

  const byKey = (k: string) => chains.find((c) => c.key === k)!

  find.addEventListener('click', async () => {
    err.textContent = ''
    replace(result)
    find.disabled = true
    replace(held, h('p', { class: 'empty busy' }, 'Reading balances…'))
    try {
      tokens = await engine.balances(byKey(from.value))
      checks.clear()
      if (tokens.length === 0) {
        replace(held, h('p', { class: 'empty' }, 'This wallet holds no tokens on that chain.'))
        plan.disabled = true
        return
      }
      const all = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Select all tokens' })
      all.addEventListener('change', () => {
        for (const c of checks.values()) c.checked = all.checked
      })
      replace(
        held,
        h(
          'table',
          { class: 'data' },
          h('caption', { class: 'sr-only' }, 'Tokens to bridge'),
          h('thead', {}, h('tr', {}, h('th', { class: 'pick' }, all), h('th', { scope: 'col' }, 'Token'), h('th', { scope: 'col', class: 'num' }, 'Balance'), h('th', { scope: 'col', class: 'num' }, 'Value'))),
          h(
            'tbody',
            {},
            tokens.map((x) => {
              const box = h('input', { type: 'checkbox', checked: true, 'aria-label': `Bridge ${x.token.symbol}` })
              checks.set(x.token.address, box)
              return h('tr', {}, h('td', { class: 'pick' }, box), h('th', { scope: 'row' }, x.token.symbol), h('td', { class: 'num' }, amount(x.balance, x.token)), h('td', { class: 'num' }, usd(x.usd)))
            }),
          ),
        ),
      )
      plan.disabled = false
    } catch (e) {
      replace(held)
      err.textContent = (e as Error).message
    } finally {
      find.disabled = false
    }
  })

  plan.addEventListener('click', async () => {
    err.textContent = ''
    const chosen = tokens.filter((x) => checks.get(x.token.address)?.checked).map((x) => x.token.symbol)
    if (chosen.length === 0) {
      err.textContent = 'Tick at least one token'
      return
    }
    if (from.value === to.value) {
      err.textContent = 'Pick two different chains'
      return
    }
    plan.disabled = true
    replace(result, h('p', { class: 'empty busy' }, 'Looking for the best route for each token. This can take a minute.'))
    try {
      const fc = byKey(from.value)
      const tc = byKey(to.value)
      const { plan: p, toAddress } = await engine.planSweep(fc, tc, chosen, target.value.trim() || undefined, recipient.value.trim() || undefined)
      replace(
        result,
        h('h2', {}, 'Plan'),
        p.items.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('caption', { class: 'sr-only' }, 'Planned transfers'), h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Token'), h('th', { scope: 'col', class: 'num' }, 'Send'), h('th', { scope: 'col', class: 'num' }, 'Receive'), h('th', { scope: 'col' }, 'Via'), h('th', { scope: 'col', class: 'num' }, 'Net value'), h('th', { scope: 'col', class: 'num' }, 'Time'))), h('tbody', {}, p.items.map((i) => h('tr', {}, h('th', { scope: 'row' }, i.from.symbol), h('td', { class: 'num' }, amount(i.amount, i.from)), h('td', { class: 'num strong' }, `${amount(i.route.legs.at(-1)!.toAmount, i.to)} ${i.to.symbol}`), h('td', { class: 'via-cell' }, via(i.route)), h('td', { class: 'num' }, usd(routeNetUsd(i.route))), h('td', { class: 'num' }, duration(routeEta(i.route))))))))
          : h('p', { class: 'empty' }, 'No token can be bridged.'),
        skippedList(p),
        p.items.length ? h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: () => void saveSweep() }, 'Save as route'), h('button', { class: 'btn primary', type: 'button', onClick: () => void reviewAndRunSweep(sheet, p, toAddress, fc, tc, () => void sweepScreen(sheet)) }, 'Review and send')) : null,
      )
    } catch (e) {
      replace(result)
      err.textContent = (e as Error).message
    } finally {
      plan.disabled = false
    }
  })

  const saveSweep = async () => {
    const name = await askText(sheet, 'Save route', 'Name', 'payday')
    if (!name) return
    try {
      await engine.saveRoute({ kind: 'sweep', name, createdAt: new Date().toISOString(), wallet: engine.requireSession().walletName, fromChain: from.value, toChain: to.value, tokens: tokens.filter((x) => checks.get(x.token.address)?.checked).map((x) => x.token.symbol), target: target.value.trim() || undefined, recipient: recipient.value.trim() || undefined })
      err.textContent = ''
      result.prepend(h('p', { class: 'banner ok' }, `Saved "${name}". Find it under Saved routes.`))
    } catch (e) {
      err.textContent = (e as Error).message
    }
  }

  replace(
    sheet,
    h('h1', { class: 'sheet-title' }, 'Bridge wallet'),
    h('p', { class: 'hint' }, 'Move many tokens from one chain to another. Each token becomes its own transfer, biggest value first, and the chain’s own coin goes last with enough held back for gas.'),
    h('form', { class: 'form transfer-form', onSubmit: (e: Event) => e.preventDefault() }, h('fieldset', { class: 'group' }, h('legend', {}, 'Chains'), h('label', { class: 'row', for: 'sw-from' }, h('span', { class: 'label' }, 'From'), from), h('label', { class: 'row', for: 'sw-to' }, h('span', { class: 'label' }, 'To'), to), h('label', { class: 'row', for: 'sw-target' }, h('span', { class: 'label' }, 'Receive as'), target), h('label', { class: 'row', for: 'sw-recipient' }, h('span', { class: 'label' }, 'Recipient'), recipient), h('div', { class: 'actions' }, find))),
    err,
    held,
    h('div', { class: 'actions' }, plan),
    result,
  )
}
