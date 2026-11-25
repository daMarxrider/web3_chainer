import type { PipelineRecord } from '@chainer/core'
import { amount, h, replace, shortAddress } from '../dom.ts'
import { engine } from '../engine.ts'
import { icon } from '../icons.ts'
import { setJob } from '../status.ts'

/**
 * The progress panel of a run: one line per leg with a lamp, a log of every step, and the
 * outcome. Used for a new transfer and for resuming an interrupted one.
 */
export async function showJob(sheet: HTMLElement, title: string, chainName: (key: string) => string, run: (onEvent: (record: PipelineRecord, leg: number, message: string) => void) => Promise<PipelineRecord>, back: () => void): Promise<void> {
  const log = h('ol', { class: 'log', 'aria-live': 'polite' })
  const legs = h('ol', { class: 'jobs' })
  const outcome = h('div', { class: 'outcome' })
  replace(sheet, h('h1', { class: 'sheet-title' }, title), h('p', { class: 'hint' }, 'The run continues while the app stays open. If it is interrupted, it is saved and you can resume it from the Transfer screen.'), legs, h('h2', {}, 'Log'), log, outcome)

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

  setJob('working', 'Transfer running')
  try {
    const result = await run((record, i, message) => {
      drawLegs(record, i)
      log.append(h('li', {}, h('time', {}, new Date().toLocaleTimeString()), ' ', message))
      setJob('working', `Leg ${i + 1} of ${record.legs.length}: ${message}`)
    })
    drawLegs(result, result.legs.length - 1)
    if (result.state === 'done') {
      const final = result.legs.at(-1)!
      setJob('done', 'Transfer finished')
      replace(outcome, h('p', { class: 'banner ok' }, icon('check'), ` Done. Received ${amount(final.received ?? '0', final.to)} ${final.to.symbol} at ${shortAddress(final.toAddress)}.`))
    } else {
      const bad = result.legs.findIndex((l) => l.state === 'failed')
      setJob('failed', `Stopped at leg ${bad + 1}`)
      replace(outcome, h('p', { class: 'banner err' }, icon('warn'), ` Stopped at leg ${bad + 1}.${bad > 0 ? ' Earlier legs are complete and their funds are in your wallet.' : ''} Fix the cause and resume it from the Transfer screen.`))
    }
  } catch (err) {
    setJob('failed', 'Transfer stopped')
    replace(outcome, h('p', { class: 'banner err' }, icon('warn'), ` ${(err as Error).message}`))
  }
  outcome.append(h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: back }, 'Back to Transfer')))
  void engine // the engine singleton owns the journal; nothing else to release here
}
