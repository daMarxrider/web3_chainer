import type { PipelineRecord } from '@chainer/core'
import { amount, h, replace, shortAddress } from '../dom.ts'
import { icon } from '../icons.ts'
import { setJob } from '../status.ts'

type OnEvent = (record: PipelineRecord, leg: number, message: string) => void

export interface JobItem {
  /** Heading of this run when there are several (a sweep has one per token). */
  label?: string
  run: (onEvent: OnEvent) => Promise<PipelineRecord>
}

/**
 * The progress panel of one or more runs, one after the other: a line per leg with a lamp, a
 * log of every step, and the outcome. A failure in one run is shown and the next one still
 * starts, because each token of a sweep is its own run.
 */
export async function showJobs(sheet: HTMLElement, title: string, chainName: (key: string) => string, items: JobItem[], back: () => void): Promise<void> {
  const log = h('ol', { class: 'log', 'aria-live': 'polite' })
  const sections = h('div', { class: 'job-sections' })
  const outcome = h('div', { class: 'outcome' })
  replace(sheet, h('h1', { class: 'sheet-title' }, title), h('p', { class: 'hint' }, 'The run continues while the app stays open. If it is interrupted, it is saved and you can resume it from the History or Transfer screen.'), sections, h('h2', {}, 'Log'), log, outcome)

  let failures = 0
  for (const [n, item] of items.entries()) {
    const legs = h('ol', { class: 'jobs' })
    const result = h('div', { class: 'job-result' })
    append(sections, [item.label ? h('h2', {}, item.label) : null, legs, result])

    const drawLegs = (record: PipelineRecord, active: number) =>
      replace(
        legs,
        ...record.legs.map((leg, i) => {
          const state = i === active && leg.state === 'waiting' ? 'running' : leg.state
          const sent = leg.amount === 'all' ? 'All' : amount(leg.amount, leg.from)
          return h(
            'li',
            { dataset: { state } },
            h('span', { class: 'lamp', dataset: { state }, 'aria-hidden': 'true' }),
            h(
              'span',
              { class: 'leg-text' },
              `${sent} ${leg.from.symbol} on ${chainName(leg.from.chainKey)} to ${leg.to.symbol} on ${chainName(leg.to.chainKey)}`,
              leg.via ? h('span', { class: 'via' }, ` via ${leg.via}`) : null,
              leg.state === 'done' && leg.received ? h('span', { class: 'ok-text' }, ` received ${amount(leg.received, leg.to)}`) : null,
              leg.state === 'failed' ? h('span', { class: 'err-text' }, ` ${leg.error}`) : null,
            ),
            h('span', { class: 'sr-only' }, state),
          )
        }),
      )

    const prefix = items.length > 1 ? `Transfer ${n + 1} of ${items.length}: ` : ''
    setJob('working', `${prefix}running`)
    try {
      const done = await item.run((record, i, message) => {
        drawLegs(record, i)
        log.append(h('li', {}, h('time', {}, new Date().toLocaleTimeString()), ' ', items.length > 1 ? `[${n + 1}] ` : '', message))
        setJob('working', `${prefix}leg ${i + 1} of ${record.legs.length}: ${message}`)
      })
      drawLegs(done, done.legs.length - 1)
      if (done.state === 'done') {
        const final = done.legs.at(-1)!
        replace(result, h('p', { class: 'banner ok' }, icon('check'), ` Done. Received ${amount(final.received ?? '0', final.to)} ${final.to.symbol} at ${shortAddress(final.toAddress)}.`))
      } else {
        failures++
        const bad = done.legs.findIndex((l) => l.state === 'failed')
        replace(result, h('p', { class: 'banner err' }, icon('warn'), ` Stopped at leg ${bad + 1}.${bad > 0 ? ' Earlier legs are complete and their funds are in your wallet.' : ''} Resume it from History once the cause is fixed.`))
      }
    } catch (err) {
      failures++
      replace(result, h('p', { class: 'banner err' }, icon('warn'), ` ${(err as Error).message}`))
    }
  }
  setJob(failures ? 'failed' : 'done', failures ? `${failures} of ${items.length} stopped` : items.length > 1 ? 'All transfers finished' : 'Transfer finished')
  outcome.append(h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: back }, 'Back')))
}

const append = (el: Element, children: (Node | null)[]) => {
  for (const c of children) if (c) el.append(c)
}

/** One run. */
export function showJob(sheet: HTMLElement, title: string, chainName: (key: string) => string, run: JobItem['run'], back: () => void): Promise<void> {
  return showJobs(sheet, title, chainName, [{ run }], back)
}
