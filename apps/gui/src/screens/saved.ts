import { routeEta, type SavedRoute } from '@chainer/core'
import { amount, duration, h, replace, usd } from '../dom.ts'
import { engine } from '../engine.ts'
import { confirmRun } from './confirm.ts'
import { showJob } from './job.ts'
import { reviewAndRunSweep } from './sweep.ts'

export const savedSummary = (r: SavedRoute): string =>
  r.kind === 'transfer'
    ? `${r.amount === 'all' ? 'Whole balance' : 'Fixed amount'} of ${r.from} to ${r.to} via ${r.via}${r.fallback ? ', best route if that one is gone' : ''}${r.minReceive ? `, at least ${r.minReceive} (smallest units)` : ''}`
    : `Sweep ${r.fromChain} to ${r.toChain}${r.tokens ? ` of ${r.tokens.join(', ')}` : ''}${r.target ? ` as ${r.target}` : ''}`

/** Re-quotes a saved route now and, after one confirmation, runs it. */
export async function runSaved(sheet: HTMLElement, saved: SavedRoute, back: () => void): Promise<void> {
  const note = h('p', { class: 'empty busy', role: 'status' }, `Quoting "${saved.name}" again…`)
  replace(sheet, h('h1', { class: 'sheet-title' }, saved.name), note)
  try {
    if (saved.kind === 'sweep') {
      const [fc, tc] = await Promise.all([engine.resolveChain(saved.fromChain), engine.resolveChain(saved.toChain)])
      const { plan, toAddress } = await engine.planSweep(fc, tc, saved.tokens, saved.target, saved.recipient)
      return reviewAndRunSweep(sheet, plan, toAddress, fc, tc, back)
    }
    const prep = await engine.prepareSaved(saved)
    const last = prep.route.legs.at(-1)!
    const accepted = await confirmRun(sheet, {
      title: `Run "${saved.name}"`,
      rows: [
        ['You send', `${prep.wholeBalance ? 'whole balance, ' : ''}${amount(prep.amount, prep.from)} ${prep.from.symbol} from ${prep.fromChain.name}`],
        ['You receive', `${amount(last.toAmount, prep.to)} ${prep.to.symbol} on ${prep.toChain.name}`],
        ['At worst', `${amount(last.toAmountMin, prep.to)} ${prep.to.symbol}`],
        ['Gas and fees', usd(prep.route.legs.reduce((s, q) => s + q.costUsd, 0))],
        ['Route', prep.route.legs.map((q) => `${q.provider}/${q.tool}`).join(' > ')],
        ['Time', `about ${duration(routeEta(prep.route))}`],
        ['Recipient', prep.toAddress],
      ],
      routes: [prep.route],
      confirmLabel: 'Run now',
      notes: prep.usedFallback ? [`The saved path "${saved.via}" is no longer offered; this uses the best route now.`] : [],
    })
    if (!accepted) return back()
    const names = (key: string) => (key === prep.fromChain.key ? prep.fromChain.name : key === prep.toChain.key ? prep.toChain.name : key)
    await showJob(sheet, `Running "${saved.name}"`, names, (onEvent) => engine.run(prep.route, accepted, onEvent, { wholeBalance: prep.wholeBalance }), back)
  } catch (e) {
    replace(sheet, h('h1', { class: 'sheet-title' }, saved.name), h('p', { class: 'form-error', role: 'alert' }, (e as Error).message), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: back }, 'Back')))
  }
}

/** Saved transfers and sweeps. They keep what you meant plus, for a transfer, the path that was best; prices are quoted again when they run. */
export async function savedScreen(sheet: HTMLElement): Promise<void> {
  const list = h('div', { class: 'table-wrap' })
  const draw = async () => {
    const routes = await engine.savedRoutes()
    if (routes.length === 0) return replace(list, h('p', { class: 'empty' }, 'No saved routes yet. Save one from the Transfer or Bridge wallet screen after choosing a route.'))
    replace(
      list,
      h(
        'table',
        { class: 'data' },
        h('caption', { class: 'sr-only' }, 'Saved routes'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'What it does'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
        h(
          'tbody',
          {},
          routes.map((r) =>
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, r.name),
              h('td', { class: 'via-cell' }, savedSummary(r)),
              h('td', { class: 'num' }, h('span', { class: 'row-actions' }, h('button', { class: 'btn small primary', type: 'button', onClick: () => void runSaved(sheet, r, () => void savedScreen(sheet)) }, 'Run'), h('button', { class: 'btn small', type: 'button', onClick: async () => { await engine.removeRoute(r.name); void draw() } }, 'Remove'))),
            ),
          ),
        ),
      ),
    )
  }
  replace(sheet, h('h1', { class: 'sheet-title' }, 'Saved routes'), h('p', { class: 'hint' }, 'Running a saved route quotes it again along its saved path. If that path is gone it stops, unless it was saved to fall back to the best route; a result below the minimum you saved always stops it. To run one on a timetable, add it under Schedules.'), list)
  void draw()
}
