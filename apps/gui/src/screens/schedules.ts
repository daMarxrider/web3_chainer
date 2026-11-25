import { parseDuration, type Trigger } from '@chainer/core'
import { h, replace, usd } from '../dom.ts'
import { engine } from '../engine.ts'
import { newSchedule } from '../scheduler.ts'
import { askLocation } from './confirm.ts'

const mins = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`)
const triggerText = (t: Trigger) =>
  t.kind === 'at' ? `once, ${new Date(t.at).toLocaleString()}` : t.kind === 'every' ? `every ${mins(t.everyMs)}${t.start ? ` from ${new Date(t.start).toLocaleString()}` : ''}` : `when gas and fees are at most ${usd(t.feesBelowUsd)} (checked every ${mins(t.checkEveryMs)}${t.repeat ? ', repeating' : ''})`

/** Saved routes run on a timetable, carried out while the app is open and unlocked. */
export async function schedulesScreen(sheet: HTMLElement): Promise<void> {
  const routes = await engine.savedRoutes()
  const err = h('p', { class: 'form-error', role: 'alert' })
  const list = h('div', { class: 'table-wrap' })

  const route = h('select', { name: 'route', id: 'sc-route' }, routes.map((r) => h('option', { value: r.name }, r.name)))
  const kind = h('select', { name: 'kind', id: 'sc-kind' }, [['at', 'Once, at a time'], ['every', 'Repeatedly'], ['when', 'When gas and fees are low']].map(([v, l]) => h('option', { value: v }, l)))
  const at = h('input', { name: 'at', id: 'sc-at', type: 'datetime-local' })
  const every = h('input', { name: 'every', id: 'sc-every', value: '1d', placeholder: '30m, 6h, 1d', class: 'num narrow' })
  const start = h('input', { name: 'start', id: 'sc-start', type: 'datetime-local' })
  const fees = h('input', { name: 'fees', id: 'sc-fees', inputmode: 'decimal', value: '3', class: 'num narrow' })
  const check = h('input', { name: 'check', id: 'sc-check', value: '30m', class: 'num narrow' })
  const repeat = h('input', { type: 'checkbox', name: 'repeat', id: 'sc-repeat' })

  const row = (id: string, label: string, control: HTMLElement) => h('label', { class: 'row', for: id, dataset: { for: id } }, h('span', { class: 'label' }, label), control)
  const rows = {
    at: [row('sc-at', 'At', at)],
    every: [row('sc-every', 'Every', every), row('sc-start', 'First run (optional)', start)],
    when: [row('sc-fees', 'Fees at most, USD', fees), row('sc-check', 'Check every', check), h('label', { class: 'check', for: 'sc-repeat' }, repeat, h('span', {}, 'Keep going after it has run'))],
  }
  const dynamic = h('div', { class: 'form' })
  const showKind = () => replace(dynamic, ...rows[kind.value as keyof typeof rows])
  kind.addEventListener('change', showKind)
  showKind()

  const draw = async () => {
    const all = await engine.schedules()
    if (all.length === 0) return replace(list, h('p', { class: 'empty' }, 'No schedules yet.'))
    replace(
      list,
      h(
        'table',
        { class: 'data' },
        h('caption', { class: 'sr-only' }, 'Schedules'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Route'), h('th', { scope: 'col' }, 'When'), h('th', { scope: 'col' }, 'Last run'), h('th', { scope: 'col' }, 'Result'), h('th', {}, h('span', { class: 'sr-only' }, 'Remove')))),
        h('tbody', {}, all.map((s) => h('tr', {}, h('th', { scope: 'row' }, s.route), h('td', { class: 'via-cell' }, s.done ? 'done' : triggerText(s.trigger)), h('td', {}, s.lastRun ? new Date(s.lastRun).toLocaleString() : '-'), h('td', { class: 'via-cell' }, s.lastResult ?? ''), h('td', { class: 'num' }, h('button', { class: 'btn small', type: 'button', onClick: async () => { await engine.removeSchedule(s.id); void draw() } }, 'Remove'))))),
      ),
    )
  }

  const add = h('button', { class: 'btn primary', type: 'submit' }, 'Schedule')
  const form = h(
    'form',
    { class: 'form', onSubmit: async (e: Event) => {
      e.preventDefault()
      err.textContent = ''
      add.disabled = true
      try {
        if (!route.value) throw new Error('Save a route first (Transfer or Bridge wallet, then Save as route)')
        let trigger: Trigger
        if (kind.value === 'at') {
          if (!at.value) throw new Error('Choose a time')
          trigger = { kind: 'at', at: new Date(at.value).toISOString() }
        } else if (kind.value === 'every') {
          trigger = { kind: 'every', everyMs: parseDuration(every.value), start: start.value ? new Date(start.value).toISOString() : undefined }
        } else {
          const limit = Number(fees.value)
          if (!(limit > 0)) throw new Error('Give the highest total gas and fees in dollars')
          trigger = { kind: 'when', feesBelowUsd: limit, checkEveryMs: parseDuration(check.value), repeat: repeat.checked }
        }
        // Nobody can answer questions during an unattended run, so the location form is answered now.
        const geo = await askLocation(sheet, 'Scheduled runs pick their bridges when they start and cannot ask you then. These may be used:')
        await engine.saveSchedule(newSchedule(route.value, trigger, geo))
        void draw()
      } catch (e2) {
        err.textContent = (e2 as Error).message
      } finally {
        add.disabled = false
      }
    } },
    h('label', { class: 'row', for: 'sc-route' }, h('span', { class: 'label' }, 'Saved route'), route),
    h('label', { class: 'row', for: 'sc-kind' }, h('span', { class: 'label' }, 'When'), kind),
    dynamic,
    err,
    h('div', { class: 'actions' }, add),
  )

  replace(
    sheet,
    h('h1', { class: 'sheet-title' }, 'Schedules'),
    h('p', { class: 'hint' }, 'Schedules run while this app is open and the wallet is unlocked; a run that is due while the app is closed starts the next time it is open. A route that needs a restricted service you did not confirm here is skipped, never asked about later.'),
    h('fieldset', { class: 'group' }, h('legend', {}, 'New schedule'), routes.length ? form : h('p', { class: 'empty' }, 'There are no saved routes to schedule yet.')),
    list,
  )
  void draw()
  // A run that finishes while this screen is open updates its row.
  const refresh = () => (sheet.dataset.screen === 'schedules' ? void draw() : document.removeEventListener('chainer:schedules', refresh))
  document.addEventListener('chainer:schedules', refresh)
}
