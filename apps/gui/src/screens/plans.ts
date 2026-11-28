import { freezeNote, type Chain, type PipelineLeg, type Token } from '@chainer/core'
import { amount, duration, h, replace, usd } from '../dom.ts'
import { engine } from '../engine.ts'
import { askLocation, confirmRun } from './confirm.ts'
import { showJob } from './job.ts'
import { tokenPicker, trustNote } from '../tokenpicker.ts'

interface LegForm {
  fromChain: string
  fromSymbol: string
  toChain: string
  toSymbol: string
  amount: string
}

/** Kept while the person moves between screens. */
let draft: LegForm[] = []

/** Chains of transfers written by hand: each leg starts when the one before has arrived and takes the best route at that moment. */
export async function plansScreen(sheet: HTMLElement): Promise<void> {
  const chains = await engine.pickerChains()
  const first = chains.find((c) => c.key === (engine.testMode ? 'arct' : 'arb'))?.key ?? chains[0]!.key
  const second = chains.find((c) => c.key === (engine.testMode ? 'bast' : 'bas'))?.key ?? chains[1]!.key
  if (draft.length === 0 || draft.some((l) => !chains.some((c) => c.key === l.fromChain) || !chains.some((c) => c.key === l.toChain))) {
    draft = [{ fromChain: first, fromSymbol: 'USDC', toChain: second, toSymbol: 'USDC', amount: '' }]
  }
  const byKey = (k: string) => chains.find((c) => c.key === k)!
  const err = h('p', { class: 'form-error', role: 'alert' })
  const out = h('section', { class: 'results', 'aria-live': 'polite' })
  const legsBox = h('div', { class: 'leg-forms' })
  const recipient = h('input', { name: 'recipient', id: 'pl-recipient', placeholder: 'your own address, or an address book label', autocomplete: 'off', spellcheck: 'false' })

  const select = (value: string, on: (v: string) => void, label: string) => {
    const el = h('select', { 'aria-label': label }, chains.map((c) => h('option', { value: c.key, selected: c.key === value }, c.name)))
    el.addEventListener('change', () => on(el.value))
    return el
  }
  type Picker = ReturnType<typeof tokenPicker>
  // One picker per token field, rebuilt with the legs; each follows the chain chosen next to it.
  let pickers: { from: Picker; to: Picker }[] = []
  const picker = (id: string, chain: () => string, value: string, on: (v: string) => void, label: string, placeholder: string) => {
    const p = tokenPicker({ id, value, placeholder, label })
    void p.setChain(byKey(chain()))
    p.input.addEventListener('input', () => on(p.input.value))
    return p
  }
  const text = (value: string, on: (v: string) => void, label: string, placeholder = '', cls = '') => {
    const el = h('input', { value, placeholder, 'aria-label': label, autocomplete: 'off', class: cls })
    el.addEventListener('input', () => on(el.value))
    return el
  }

  const drawLegs = () => {
    pickers = draft.map((l, i) => ({
      from: picker(`pl-${i}-from`, () => l.fromChain, l.fromSymbol, (v) => (l.fromSymbol = v), `Leg ${i + 1} token to send`, 'USDC'),
      to: picker(`pl-${i}-to`, () => l.toChain, l.toSymbol, (v) => (l.toSymbol = v), `Leg ${i + 1} token to receive`, 'USDC'),
    }))
    replace(
      legsBox,
      ...draft.map((l, i) =>
        h(
          'fieldset',
          { class: 'group' },
          h('legend', {}, `Leg ${i + 1}`),
          h('div', { class: 'leg-grid' }, select(l.fromChain, (v) => ((l.fromChain = v), void pickers[i]!.from.setChain(byKey(v))), `Leg ${i + 1} from chain`), pickers[i]!.from.el, h('span', { class: 'leg-arrow' }, 'to'), select(l.toChain, (v) => ((l.toChain = v), void pickers[i]!.to.setChain(byKey(v))), `Leg ${i + 1} to chain`), pickers[i]!.to.el, text(l.amount, (v) => (l.amount = v), `Leg ${i + 1} amount`, i === 0 ? '10' : 'all', 'num')),
          draft.length > 1 ? h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', onClick: () => { draft.splice(i, 1); drawLegs() } }, 'Remove leg')) : null,
        ),
      ),
    )
  }
  drawLegs()

  const build = async (): Promise<{ legs: Omit<PipelineLeg, 'state'>[]; tokens: { from: Token; to: Token; fromChain: Chain; toChain: Chain }[]; tokenNotes: string[] }> => {
    const legs: Omit<PipelineLeg, 'state'>[] = []
    const tokens: { from: Token; to: Token; fromChain: Chain; toChain: Chain }[] = []
    const tokenNotes: string[] = []
    for (const [i, l] of draft.entries()) {
      if (!l.fromSymbol.trim() || !l.toSymbol.trim()) throw new Error(`Leg ${i + 1} needs a token to send and a token to receive`)
      const [fc, tc] = [byKey(l.fromChain), byKey(l.toChain)]
      const [fromRated, toRated] = await Promise.all([
        pickers[i]!.from.resolve(l.fromSymbol, `Leg ${i + 1}: there is no token "${l.fromSymbol.trim()}" on ${fc.name}.`),
        pickers[i]!.to.resolve(l.toSymbol, `Leg ${i + 1}: there is no token "${l.toSymbol.trim()}" on ${tc.name}.`),
      ])
      const [from, to] = [fromRated.token, toRated.token]
      for (const n of [trustNote(fromRated, fc, pickers[i]!.from.covers()), trustNote(toRated, tc, pickers[i]!.to.covers()), freezeNote(to, tc)]) if (n && !tokenNotes.includes(n)) tokenNotes.push(n)
      const a = l.amount.trim().toLowerCase()
      if (i === 0 && a === 'all') throw new Error('Leg 1 needs an amount; later legs can send "all" of what arrived')
      if (i > 0 && a !== 'all' && a !== '') throw new Error(`Leg ${i + 1} must send "all": it continues with what the previous leg delivered`)
      const last = i === draft.length - 1
      if (i > 0 && draft[i - 1]!.toChain !== l.fromChain) throw new Error(`Leg ${i + 1} must start on the chain leg ${i} ends on`)
      legs.push({ from, to, amount: i === 0 ? engine.parseAmount(l.amount, from).toString() : 'all', fromAddress: engine.ownAddress(fc), toAddress: last ? engine.recipientOn(tc, recipient.value) : engine.ownAddress(tc) })
      tokens.push({ from, to, fromChain: fc, toChain: tc })
    }
    return { legs, tokens, tokenNotes }
  }

  const dry = h('button', { class: 'btn', type: 'button' }, 'Dry run')
  const run = h('button', { class: 'btn primary', type: 'button' }, 'Review and run')

  dry.addEventListener('click', async () => {
    err.textContent = ''
    dry.disabled = true
    replace(out, h('p', { class: 'empty busy' }, 'Quoting each leg with what the one before would deliver at worst.'))
    try {
      const { legs, tokens, tokenNotes } = await build()
      let carried: bigint | undefined
      const rows: HTMLElement[] = []
      for (const [i, leg] of legs.entries()) {
        const a = leg.amount === 'all' ? carried : BigInt(leg.amount)
        if (a === undefined) {
          rows.push(h('tr', {}, h('th', { scope: 'row' }, `Leg ${i + 1}`), h('td', { colspan: 4 }, 'quoted when it runs')))
          continue
        }
        const { routes, errors } = await engine.findRoutes(leg.from, leg.to, a, leg.toAddress)
        const best = routes[0]
        if (!best) throw new Error(`Leg ${i + 1} has no route${errors.length ? `: ${errors.join('; ')}` : ''}`)
        const q = best.legs.at(-1)!
        carried = q.toAmountMin
        rows.push(h('tr', {}, h('th', { scope: 'row' }, `Leg ${i + 1}`), h('td', { class: 'via-cell' }, best.legs.map((x) => `${x.provider}/${x.tool}`).join(' > ')), h('td', { class: 'num strong' }, `${amount(q.toAmount, tokens[i]!.to)} ${tokens[i]!.to.symbol}`), h('td', { class: 'num' }, amount(q.toAmountMin, tokens[i]!.to)), h('td', { class: 'num' }, `${usd(best.legs.reduce((s, x) => s + x.costUsd, 0))}, ${duration(best.legs.reduce((s, x) => s + x.etaSeconds, 0))}`)))
      }
      replace(out, h('h2', {}, 'Dry run'), h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('caption', { class: 'sr-only' }, 'Quote for each leg'), h('thead', {}, h('tr', {}, h('th', {}, 'Leg'), h('th', {}, 'Best route now'), h('th', { class: 'num' }, 'Receive'), h('th', { class: 'num' }, 'At worst'), h('th', { class: 'num' }, 'Cost, time'))), h('tbody', {}, rows))), ...tokenNotes.map((n) => h('p', { class: 'notice' }, n)), h('p', { class: 'hint' }, 'Nothing was signed or sent. Each leg is quoted again when it starts and takes the best route then.'))
    } catch (e) {
      replace(out)
      err.textContent = (e as Error).message
    } finally {
      dry.disabled = false
    }
  })

  run.addEventListener('click', async () => {
    err.textContent = ''
    run.disabled = true
    try {
      const { legs, tokens, tokenNotes } = await build()
      const gas = await engine.planGasForLegs(legs)
      const ok = await confirmRun(sheet, {
        title: 'Run plan',
        rows: legs.map((l, i): [string, string] => [`Leg ${i + 1}`, `${i === 0 ? amount(l.amount, tokens[i]!.from) : 'all'} ${tokens[i]!.from.symbol} on ${tokens[i]!.fromChain.name} to ${tokens[i]!.to.symbol} on ${tokens[i]!.toChain.name}`]).concat([['Recipient', legs.at(-1)!.toAddress]]),
        routes: [],
        confirmLabel: 'Continue',
        notes: [...tokenNotes, 'The best route for each leg is picked when that leg starts, so the exact bridges are not known yet.', ...gas.stops.map((t) => `Gas ahead: about ${usd(t.usd)} into ${byKey(t.stop.chainKey)?.name ?? t.stop.chainKey}'s coin before the first leg.`), ...(gas.topUp ? [`Gas top-up for the recipient after the last leg.`] : [])],
      })
      if (!ok) return
      const geo = await askLocation(sheet, 'This plan picks its bridges while it runs and may use any of these:')
      const name = (key: string) => byKey(key)?.name ?? key
      await showJob(sheet, 'Plan in progress', name, (onEvent) => engine.runPlan(legs, geo, onEvent, gas), () => void plansScreen(sheet))
    } catch (e) {
      err.textContent = (e as Error).message
    } finally {
      run.disabled = false
    }
  })

  replace(
    sheet,
    h('h1', { class: 'sheet-title' }, 'Pipeline builder'),
    h('p', { class: 'hint' }, 'Write a chain of transfers yourself. The first leg has an amount; each later leg sends "all" of what the previous one delivered, starting on the chain it ended on.'),
    legsBox,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: () => { const last = draft.at(-1)!; draft.push({ fromChain: last.toChain, fromSymbol: last.toSymbol, toChain: first, toSymbol: last.toSymbol, amount: 'all' }); drawLegs() } }, 'Add a leg')),
    h('fieldset', { class: 'group' }, h('legend', {}, 'Recipient of the last leg'), h('label', { class: 'row', for: 'pl-recipient' }, h('span', { class: 'label' }, 'Recipient'), recipient)),
    err,
    h('div', { class: 'actions' }, dry, run),
    out,
  )
}
