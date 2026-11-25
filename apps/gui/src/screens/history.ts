import { h, replace, amount } from '../dom.ts'
import { engine } from '../engine.ts'
import { showJob } from './job.ts'

/** Every run in the journal of the current network mode, newest first. */
export async function historyScreen(sheet: HTMLElement): Promise<void> {
  const all = await engine.chains()
  const nameOf = (key: string) => all.find((c) => c.key === key)?.name ?? key
  const runs = await engine.history()
  const box = h('div', { class: 'table-wrap' })
  if (runs.length === 0) {
    replace(sheet, h('h1', { class: 'sheet-title' }, 'History'), h('p', { class: 'empty' }, `No transfers yet on ${engine.testMode ? 'test' : 'real'} networks.`))
    return
  }
  replace(
    box,
    h(
      'table',
      { class: 'data' },
      h('caption', { class: 'sr-only' }, 'Transfers, newest first'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Started'), h('th', { scope: 'col' }, 'Transfer'), h('th', { scope: 'col' }, 'State'), h('th', { scope: 'col', class: 'num' }, 'Legs'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
      h(
        'tbody',
        {},
        runs.map((r) => {
          const first = r.legs[0]!
          const last = r.legs.at(-1)!
          const done = r.legs.filter((l) => l.state === 'done').length
          const action = r.state === 'done' ? null : h('button', { class: 'btn small', type: 'button', onClick: () => void showJob(sheet, 'Resuming transfer', nameOf, (onEvent) => engine.resume(r, onEvent), () => void historyScreen(sheet)) }, 'Resume')
          return h('tr', {}, h('td', {}, new Date(r.createdAt).toLocaleString()), h('th', { scope: 'row', class: 'via-cell' }, `${first.amount === 'all' ? 'All' : amount(first.amount, first.from)} ${first.from.symbol} on ${nameOf(first.from.chainKey)} to ${last.to.symbol} on ${nameOf(last.to.chainKey)}`, last.state === 'done' && last.received ? h('span', { class: 'via' }, ` received ${amount(last.received, last.to)}`) : null, r.legs.find((l) => l.state === 'failed')?.error ? h('span', { class: 'err-text block' }, r.legs.find((l) => l.state === 'failed')!.error!.split('\n')[0]) : null), h('td', {}, h('span', { class: 'state', dataset: { state: r.state } }, r.state === 'running' ? 'unfinished' : r.state)), h('td', { class: 'num' }, `${done}/${r.legs.length}`), h('td', { class: 'num' }, action))
        }),
      ),
    ),
  )
  replace(sheet, h('h1', { class: 'sheet-title' }, 'History'), box)
}
