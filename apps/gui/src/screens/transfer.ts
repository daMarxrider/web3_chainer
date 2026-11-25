import { geoKeys, geoNotices, geoStatement, parseUnits, resolveRecipient, routeEta, routeNetUsd, type Chain, type PipelineRecord, type Route, type Token } from '@chainer/core'
import { amount, duration, h, replace, shortAddress, usd } from '../dom.ts'
import { engine } from '../engine.ts'
import { icon } from '../icons.ts'
import { askText } from './confirm.ts'
import { showJob } from './job.ts'

interface Form {
  fromChain?: string
  fromSymbol: string
  amount: string
  toChain?: string
  toSymbol: string
  recipient: string
}
/** Kept while the person moves between screens. */
const form: Form = { fromSymbol: '', amount: '', toSymbol: '', recipient: '' }

const routeVia = (route: Route) => route.legs.map((q) => `${q.provider}/${q.tool}`).join(' > ')

export async function transferScreen(sheet: HTMLElement): Promise<void> {
  const chains = await engine.pickerChains()
  const byKey = (key: string) => chains.find((c) => c.key === key)!
  form.fromChain ??= chains.find((c) => c.key === (engine.testMode ? 'arct' : 'arb'))?.key ?? chains[0]!.key
  form.toChain ??= chains.find((c) => c.key === (engine.testMode ? 'bast' : 'bas'))?.key ?? chains[1]!.key
  if (!chains.some((c) => c.key === form.fromChain)) form.fromChain = chains[0]!.key
  if (!chains.some((c) => c.key === form.toChain)) form.toChain = chains[1]!.key

  const chainSelect = (name: string, value: string) => h('select', { name, id: `f-${name}` }, chains.map((c) => h('option', { value: c.key, selected: c.key === value }, c.name)))
  const fromChain = chainSelect('fromChain', form.fromChain)
  const toChain = chainSelect('toChain', form.toChain)
  const fromSymbol = h('input', { name: 'fromSymbol', id: 'f-fromSymbol', list: 'held-tokens', value: form.fromSymbol, placeholder: 'USDC', autocomplete: 'off', required: true })
  const toSymbol = h('input', { name: 'toSymbol', id: 'f-toSymbol', value: form.toSymbol, placeholder: 'same as sent', autocomplete: 'off' })
  const amountInput = h('input', { name: 'amount', id: 'f-amount', inputmode: 'decimal', value: form.amount, placeholder: '0.00', autocomplete: 'off', required: true, class: 'num' })
  const recipient = h('input', { name: 'recipient', id: 'f-recipient', value: form.recipient, placeholder: 'your own address on the destination', autocomplete: 'off', spellcheck: 'false' })
  const datalist = h('datalist', { id: 'held-tokens' })
  const heldNote = h('p', { class: 'hint', id: 'held-note' })
  const maxBtn = h('button', { class: 'btn small', type: 'button', disabled: true }, 'Max')
  const findBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Find routes')
  const formError = h('p', { class: 'form-error', role: 'alert' })
  const results = h('section', { class: 'results', 'aria-live': 'polite' })
  let held: { token: Token; balance: bigint }[] = []

  const loadHeld = async () => {
    held = []
    replace(datalist)
    heldNote.textContent = ''
    try {
      held = await engine.balances(byKey(fromChain.value))
      replace(datalist, ...held.map((x) => h('option', { value: x.token.symbol }, `${amount(x.balance, x.token)} ${x.token.symbol}`)))
      heldNote.textContent = held.length ? `You hold ${held.slice(0, 4).map((x) => `${amount(x.balance, x.token)} ${x.token.symbol}`).join(', ')}${held.length > 4 ? ` and ${held.length - 4} more` : ''} on this chain.` : 'This wallet holds no tokens on this chain.'
      syncMax()
    } catch (err) {
      heldNote.textContent = `Could not read balances: ${(err as Error).message}`
    }
  }
  const heldToken = () => held.find((x) => x.token.symbol.toLowerCase() === fromSymbol.value.trim().toLowerCase())
  const syncMax = () => {
    const x = heldToken()
    // The chain's own coin pays for gas, so "all of it" is not offered.
    maxBtn.disabled = !x || x.token.address.startsWith('0x0000')
    maxBtn.title = x?.token.address.startsWith('0x0000') ? 'Keep some of the chain’s own coin for gas' : 'Send the whole balance of this token'
  }
  maxBtn.addEventListener('click', () => {
    const x = heldToken()
    if (x) amountInput.value = amount(x.balance, x.token, x.token.decimals).replaceAll(',', '')
  })
  fromChain.addEventListener('change', () => void loadHeld())
  fromSymbol.addEventListener('input', syncMax)

  const readForm = async (): Promise<{ from: Token; to: Token; amount: bigint; toAddress: string; fromChain: Chain; toChain: Chain }> => {
    const [fc, tc] = [byKey(fromChain.value), byKey(toChain.value)]
    const symbol = fromSymbol.value.trim()
    if (!symbol) throw new Error('Enter the token to send')
    const [from, to] = await Promise.all([engine.token(fc, symbol), engine.token(tc, toSymbol.value.trim() || symbol)])
    if (!/^\d+(\.\d+)?$/.test(amountInput.value.trim())) throw new Error(`"${amountInput.value}" is not a valid amount`)
    const value = parseUnits(amountInput.value.trim(), from.decimals)
    if (value === 0n) throw new Error('The amount must be greater than zero')
    const own = engine.ownAddress(tc)
    const typed = recipient.value.trim()
    const toAddress = typed ? resolveRecipient(engine.settings, typed, tc.key) : own
    if (!engine.adapterFor(tc).validateAddress(toAddress)) throw new Error(`"${toAddress}" is not a valid address on ${tc.name}`)
    const { maxUsdPerTransfer } = engine.settings
    const valueUsd = from.priceUsd === undefined ? undefined : (Number(value) / 10 ** from.decimals) * from.priceUsd
    if (!engine.testMode && maxUsdPerTransfer !== null && valueUsd !== undefined && valueUsd > maxUsdPerTransfer) {
      throw new Error(`This is worth about ${usd(valueUsd)}, above your limit of ${usd(maxUsdPerTransfer)}. Change the limit in Settings.`)
    }
    return { from, to, amount: value, toAddress, fromChain: fc, toChain: tc }
  }

  const search = async (e: Event) => {
    e.preventDefault()
    formError.textContent = ''
    Object.assign(form, { fromChain: fromChain.value, toChain: toChain.value, fromSymbol: fromSymbol.value, toSymbol: toSymbol.value, amount: amountInput.value, recipient: recipient.value })
    findBtn.disabled = true
    replace(results, h('p', { class: 'empty busy' }, 'Asking every route source. This takes a few seconds.'))
    try {
      const req = await readForm()
      const balance = held.find((x) => x.token.address.toLowerCase() === req.from.address.toLowerCase())?.balance ?? 0n
      const { routes, errors } = await engine.findRoutes(req.from, req.to, req.amount, req.toAddress)
      if (routes.length === 0) {
        replace(results, h('p', { class: 'form-error', role: 'alert' }, errors.length ? `No route found. ${errors.join('; ')}` : 'No route found, also not through other chains.'))
        return
      }
      showRoutes(req, routes, balance, errors)
    } catch (err) {
      replace(results)
      formError.textContent = (err as Error).message
    } finally {
      findBtn.disabled = false
    }
  }

  // ---- ranked routes ----

  const showRoutes = (req: Awaited<ReturnType<typeof readForm>>, routes: Route[], balance: bigint, errors: string[]) => {
    let chosen = 0
    const detail = h('div', { class: 'route-detail' })
    const send = h('button', { class: 'btn primary', type: 'button' }, 'Review and send')
    const save = h('button', { class: 'btn', type: 'button' }, 'Save as route')
    save.addEventListener('click', async () => {
      const name = await askText(sheet, 'Save route', 'Name', 'weekly-usdc')
      if (!name) return
      try {
        await engine.saveRoute({ kind: 'transfer', name, createdAt: new Date().toISOString(), wallet: engine.requireSession().walletName, from: `${req.from.symbol}@${req.fromChain.key}`, to: `${req.to.symbol}@${req.toChain.key}`, amount: req.amount.toString(), recipient: recipient.value.trim() || undefined, via: routeVia(routes[chosen]!), fallback: false })
        results.prepend(h('p', { class: 'banner ok' }, `Saved "${name}". Find it under Saved routes.`))
      } catch (e) {
        formError.textContent = (e as Error).message
      }
    })
    const draw = () => {
      const r = routes[chosen]!
      const notices = geoNotices(r.legs)
      replace(
        detail,
        h('h3', {}, 'This route'),
        h('ol', { class: 'legs' }, r.legs.map((q) => h('li', {}, `${amount(q.request.amount, q.request.from)} ${q.request.from.symbol} on ${byName(q.request.from.chainKey)} `, icon('arrow'), ` ${amount(q.toAmount, q.request.to)} ${q.request.to.symbol} on ${byName(q.request.to.chainKey)}`, h('span', { class: 'via' }, ` via ${q.provider}/${q.tool}`)))),
        notices.length ? h('p', { class: 'notice' }, icon('warn'), ` Uses ${notices.map((n) => n.name).join(', ')}, which restrict where they can be used. You confirm your location before sending.`) : null,
        r.legs.length > 1 ? h('p', { class: 'hint' }, `No direct connection: this goes through ${r.legs.length - 1} stop-over${r.legs.length > 2 ? 's' : ''}; each leg starts by itself when the one before has arrived.`) : null,
      )
    }
    const last = (r: Route) => r.legs.at(-1)!
    const body = h(
      'tbody',
      {},
      routes.slice(0, 8).map((r, i) =>
        h(
          'tr',
          { dataset: { selected: String(i === 0) } },
          h('td', { class: 'pick' }, h('input', { type: 'radio', name: 'route', value: String(i), checked: i === 0, 'aria-label': `Route ${i + 1}: ${routeVia(r)}`, onChange: () => { chosen = i; for (const [n, row] of body.querySelectorAll('tr').entries()) row.dataset.selected = String(n === i); draw() } })),
          h('th', { scope: 'row', class: 'via-cell' }, routeVia(r), geoKeys(r.legs).length ? h('span', { class: 'tag' }, 'region') : null),
          h('td', { class: 'num strong' }, `${amount(last(r).toAmount, req.to)} ${req.to.symbol}`),
          h('td', { class: 'num' }, amount(last(r).toAmountMin, req.to)),
          h('td', { class: 'num' }, usd(r.legs.reduce((s, q) => s + q.costUsd, 0))),
          h('td', { class: 'num' }, usd(routeNetUsd(r))),
          h('td', { class: 'num' }, duration(routeEta(r))),
        ),
      ),
    )
    send.addEventListener('click', () => confirm(req, routes[chosen]!, balance))
    replace(
      results,
      h('h2', {}, `${routes.length} route${routes.length === 1 ? '' : 's'}, ${engine.settings.prefer} first`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data routes' }, h('caption', { class: 'sr-only' }, 'Routes ranked by what arrives'), h('thead', {}, h('tr', {}, h('th', {}, h('span', { class: 'sr-only' }, 'Choose')), h('th', { scope: 'col' }, 'Via'), h('th', { scope: 'col', class: 'num' }, 'You receive'), h('th', { scope: 'col', class: 'num' }, 'At worst'), h('th', { scope: 'col', class: 'num' }, 'Gas + fees'), h('th', { scope: 'col', class: 'num' }, 'Net value'), h('th', { scope: 'col', class: 'num' }, 'Time'))), body)),
      errors.length ? h('p', { class: 'hint' }, `Some sources did not answer: ${errors.join('; ')}`) : null,
      detail,
      h('div', { class: 'actions' }, save, send),
    )
    draw()
  }
  const byName = (key: string) => chains.find((c) => c.key === key)?.name ?? key

  // ---- one confirmation, then the job ----

  const confirm = (req: Awaited<ReturnType<typeof readForm>>, route: Route, balance: bigint) => {
    if (balance < req.amount) {
      results.prepend(h('p', { class: 'form-error', role: 'alert' }, `The wallet holds ${amount(balance, req.from)} ${req.from.symbol} on ${req.fromChain.name}, less than you want to send.`))
      return
    }
    const notices = engine.testMode ? [] : geoNotices(route.legs)
    const ok = h('input', { type: 'checkbox', id: 'geo-ok' })
    const go = h('button', { class: 'btn primary', type: 'button', disabled: notices.length > 0 }, 'Send now')
    ok.addEventListener('change', () => (go.disabled = !ok.checked))
    const dlg = h(
      'dialog',
      { class: 'window dialog', 'aria-labelledby': 'dlg-title' },
      h('header', { class: 'titlebar' }, h('span', { class: 'title', id: 'dlg-title' }, 'Confirm transfer')),
      h(
        'div',
        { class: 'dialog-body' },
        engine.testMode ? h('p', { class: 'banner test' }, 'Test networks: this moves test funds only.') : h('p', { class: 'banner real' }, 'Real networks: this moves real money and cannot be undone.'),
        h(
          'dl',
          { class: 'summary' },
          h('dt', {}, 'You send'), h('dd', { class: 'strong' }, `${amount(req.amount, req.from)} ${req.from.symbol} from ${req.fromChain.name}`),
          h('dt', {}, 'You receive'), h('dd', { class: 'strong' }, `${amount(route.legs.at(-1)!.toAmount, req.to)} ${req.to.symbol} on ${req.toChain.name}`),
          h('dt', {}, 'At worst'), h('dd', {}, `${amount(route.legs.at(-1)!.toAmountMin, req.to)} ${req.to.symbol}`),
          h('dt', {}, 'Gas and fees'), h('dd', {}, usd(route.legs.reduce((s, q) => s + q.costUsd, 0))),
          h('dt', {}, 'Route'), h('dd', {}, routeVia(route)),
          h('dt', {}, 'Time'), h('dd', {}, `about ${duration(routeEta(route))}`),
          h('dt', {}, 'Recipient'), h('dd', { class: 'mono' }, req.toAddress),
        ),
        notices.length
          ? h('div', { class: 'geo' }, h('h3', {}, icon('warn'), ' Restricted services'), h('ul', {}, notices.map((n) => h('li', {}, h('strong', {}, n.name), ` is ${n.onlyIn ? 'only available in' : 'not available in'}: ${n.regions.join(', ')}. `, n.note ?? '', h('span', { class: 'via' }, ` Source: ${n.terms}`)))), h('label', { class: 'check', for: 'geo-ok' }, ok, h('span', {}, geoStatement(notices))))
          : null,
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: () => dlg.close() }, 'Cancel'), go),
      ),
    )
    dlg.addEventListener('close', () => dlg.remove())
    go.addEventListener('click', () => {
      dlg.close()
      void start(route, geoKeys(route.legs))
    })
    sheet.append(dlg)
    dlg.showModal()
  }

  const start = (route: Route, accepted: string[]) =>
    showJob(sheet, 'Transfer in progress', byName, (onEvent) => engine.run(route, accepted, onEvent), () => void transferScreen(sheet))

  // Runs the journal says are not finished, with a way to pick them up again.
  const unfinishedBox = h('section', { class: 'unfinished' })
  void engine.unfinished().then((runs) => {
    if (runs.length === 0) return
    const notices = (r: PipelineRecord) => (engine.testMode ? [] : geoNotices((r.geoAccepted ?? []).map((tool) => ({ provider: 'lifi', tool }))))
    replace(
      unfinishedBox,
      h('h2', {}, 'Unfinished transfers'),
      h('p', { class: 'hint' }, 'These were started and did not finish. Resuming never sends a step twice that already went out.'),
      h('ul', { class: 'run-list' }, runs.slice(0, 5).map((r) => {
        const first = r.legs[0]!
        const last = r.legs.at(-1)!
        const done = r.legs.filter((l) => l.state === 'done').length
        const resume = h('button', { class: 'btn small', type: 'button' }, 'Resume')
        resume.addEventListener('click', () => {
          const n = notices(r)
          const go = () => void showJob(sheet, 'Resuming transfer', byName, (onEvent) => engine.resume(r, onEvent), () => void transferScreen(sheet))
          if (n.length === 0) return go()
          askLocation(n, go)
        })
        return h('li', {}, h('span', {}, `${first.amount === 'all' ? 'All' : amount(first.amount, first.from)} ${first.from.symbol} on ${byName(first.from.chainKey)} to ${last.to.symbol} on ${byName(last.to.chainKey)}`, h('span', { class: 'via' }, ` ${done} of ${r.legs.length} legs done, started ${new Date(r.createdAt).toLocaleString()}`)), resume)
      })),
    )
  })

  // Your location may have changed since the run started, so the restricted-region question is asked again.
  const askLocation = (n: ReturnType<typeof geoNotices>, go: () => void) => {
    const ok = h('input', { type: 'checkbox', id: 'geo-again' })
    const yes = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Resume')
    ok.addEventListener('change', () => (yes.disabled = !ok.checked))
    const dlg = h('dialog', { class: 'window dialog', 'aria-labelledby': 'dlg2' }, h('header', { class: 'titlebar' }, h('span', { class: 'title', id: 'dlg2' }, 'Confirm your location')), h('div', { class: 'dialog-body' }, h('div', { class: 'geo' }, h('h3', {}, icon('warn'), ' Restricted services'), h('ul', {}, n.map((x) => h('li', {}, h('strong', {}, x.name), ` is ${x.onlyIn ? 'only available in' : 'not available in'}: ${x.regions.join(', ')}.`))), h('label', { class: 'check', for: 'geo-again' }, ok, h('span', {}, geoStatement(n)))), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onClick: () => dlg.close() }, 'Cancel'), yes)))
    dlg.addEventListener('close', () => dlg.remove())
    yes.addEventListener('click', () => (dlg.close(), go()))
    sheet.append(dlg)
    dlg.showModal()
  }

  replace(
    sheet,
    h('h1', { class: 'sheet-title' }, 'Transfer'),
    unfinishedBox,
    h(
      'form',
      { class: 'form transfer-form', onSubmit: search },
      h('fieldset', { class: 'group' }, h('legend', {}, 'From'), h('label', { class: 'row', for: 'f-fromChain' }, h('span', { class: 'label' }, 'Chain'), fromChain), h('label', { class: 'row', for: 'f-fromSymbol' }, h('span', { class: 'label' }, 'Token'), fromSymbol), datalist, h('label', { class: 'row', for: 'f-amount' }, h('span', { class: 'label' }, 'Amount'), h('span', { class: 'with-button' }, amountInput, maxBtn)), heldNote),
      h('fieldset', { class: 'group' }, h('legend', {}, 'To'), h('label', { class: 'row', for: 'f-toChain' }, h('span', { class: 'label' }, 'Chain'), toChain), h('label', { class: 'row', for: 'f-toSymbol' }, h('span', { class: 'label' }, 'Token'), toSymbol), h('label', { class: 'row', for: 'f-recipient' }, h('span', { class: 'label' }, 'Recipient'), recipient)),
      formError,
      h('div', { class: 'actions' }, findBtn),
    ),
    results,
  )
  void loadHeld()
}
