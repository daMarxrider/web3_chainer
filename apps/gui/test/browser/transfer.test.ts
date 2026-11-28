// The Transfer screen in headless Chromium against the fake network: form, token picker, routes,
// the confirmation, the job view, saving a route and resuming unfinished runs.
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { browserMissing, lazyBrowser, ME, setUpApp, unlock, type Page } from './harness.ts'
import { standardWorld, TOKENS } from './worlds.ts'
import type { World } from '../../../../testing/fakenet/world.ts'

const b = lazyBrowser()
after(() => b.close())

async function transferScreen(t: { after: (fn: () => Promise<void>) => void }, world: World = standardWorld(), opts: { prefs?: Record<string, unknown>; settings?: Record<string, unknown>; storage?: Record<string, string> } = {}): Promise<Page> {
  const page = await b.page(world)
  t.after(async () => {
    assert.deepEqual(page.unexpected, [], 'the page asked for something the fake network does not know')
    assert.deepEqual(page.errors, [], 'the page had uncaught errors')
    await page.close()
  })
  await page.open({ ...(await setUpApp({ lastChain: 'arb', ...opts.prefs }, opts.settings)), ...opts.storage })
  await unlock(page)
  await page.click('.sheetlist button', 'Transfer')
  await page.waitFor('document.querySelector("#f-amount") && document.querySelector("#held-note").textContent.length > 0')
  return page
}
const fillForm = async (page: Page, f: { token?: string; amount?: string; toChain?: string; toToken?: string; recipient?: string }) => {
  if (f.token !== undefined) await page.fill('#f-fromSymbol', f.token)
  if (f.amount !== undefined) await page.fill('#f-amount', f.amount)
  if (f.toChain !== undefined) await page.fill('#f-toChain', f.toChain)
  if (f.toToken !== undefined) await page.fill('#f-toSymbol', f.toToken)
  if (f.recipient !== undefined) await page.fill('#f-recipient', f.recipient)
}
const findRoutes = (page: Page) => page.evaluate('document.querySelector("#f-amount").form.requestSubmit()')
const formError = (page: Page, text: string) => page.waitFor(`document.querySelector(".transfer-form .form-error").textContent === ${JSON.stringify(text)}`)
const routesShown = (page: Page) => page.waitFor('document.querySelectorAll("input[name=route]").length > 0')
const sends = (page: Page) => page.log.filter((l) => l.kind === 'request' && l.method === 'eth_sendRawTransaction').length

describe('the Transfer screen', { concurrency: 6, skip: browserMissing }, () => {
  // ---- the form ----

  test('the form starts from Arbitrum to Base and says what the wallet holds there', async (t) => {
    const page = await transferScreen(t)
    assert.deepEqual([await page.evaluate('document.querySelector("#f-fromChain").value'), await page.evaluate('document.querySelector("#f-toChain").value'), await page.text('#held-note')], ['arb', 'bas', 'You hold 1,000 USDC, 0.01 ETH on this chain.'])
  })

  test('a chain where the wallet holds nothing says so', async (t) => {
    const page = await transferScreen(t, standardWorld({ balances: {} }))
    assert.equal(await page.text('#held-note'), 'This wallet holds no tokens on this chain.')
  })

  test('Max is offered for a held token and fills in "all"', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC' })
    await page.click('button', 'Max')
    assert.equal(await page.evaluate('document.querySelector("#f-amount").value'), 'all')
  })

  test('Max is not offered for a token the wallet does not hold', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'DAI' })
    assert.equal(await page.evaluate('[...document.querySelectorAll("button")].find((b) => b.textContent === "Max").disabled'), true)
  })

  test('Max on the chain’s coin says gas is kept back', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'ETH' })
    assert.equal(await page.evaluate('[...document.querySelectorAll("button")].find((b) => b.textContent === "Max").title'), 'Send the whole balance, less what the transfer’s gas needs')
  })

  test('balances that cannot be read are reported under the amount', async (t) => {
    const page = await transferScreen(t, standardWorld({ tokensError: { status: 500, message: 'down' } }))
    assert.equal(await page.text('#held-note'), 'Could not read balances: li.quest responded 500: down')
  })

  // ---- refusals ----

  test('an amount that is not a number is refused with what works', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC', amount: 'lots' })
    await findRoutes(page)
    await formError(page, '"lots" is not a valid amount. Enter a number, or "all" for the whole balance.')
  })

  test('an amount of zero is refused', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC', amount: '0' })
    await findRoutes(page)
    await formError(page, 'The amount must be greater than zero')
  })

  test('a token the chain does not have is named', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'XYZ', amount: '1' })
    await findRoutes(page)
    await formError(page, 'There is no token "XYZ" on Arbitrum.')
  })

  test('a token missing on the destination asks for the token to receive', async (t) => {
    const page = await transferScreen(t, standardWorld({ tokens: [TOKENS.usdcArb] }))
    await fillForm(page, { token: 'USDC', amount: '1' })
    await findRoutes(page)
    await formError(page, 'USDC does not exist on Base. Choose the token to receive under To, Token.')
  })

  test('a token to receive that the destination does not have is named', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC', amount: '1', toToken: 'XYZ' })
    await findRoutes(page)
    await formError(page, 'There is no token "XYZ" on Base.')
  })

  test('"all" of a token the wallet does not hold is refused', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'ETH', amount: 'all', toChain: 'eth' })
    await page.fill('#f-fromChain', 'bas')
    await page.waitFor('document.querySelector("#held-note").textContent.length > 0')
    page.setWorld(standardWorld({ balances: {} }))
    await page.fill('#f-fromChain', 'eth')
    await page.waitFor('document.querySelector("#held-note").textContent === "This wallet holds no tokens on this chain."')
    await findRoutes(page)
    await formError(page, 'The wallet holds no ETH on Ethereum, so there is nothing to send.')
  })

  test('a recipient that is not an address on the destination is refused', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC', amount: '1', recipient: 'nobody' })
    await findRoutes(page)
    await formError(page, '"nobody" is not a valid address on Base')
  })

  test('a transfer worth more than the limit is refused with where to change it', async (t) => {
    const page = await transferScreen(t, standardWorld(), { settings: { maxUsdPerTransfer: 50 } })
    await fillForm(page, { token: 'USDC', amount: '100' })
    await findRoutes(page)
    await formError(page, 'This is worth about $100.00, above your limit of $50.00. Change the limit in Settings.')
  })

  test('no route at all says so', async (t) => {
    const page = await transferScreen(t, standardWorld({ routes: [] }))
    await fillForm(page, { token: 'USDC', amount: '1' })
    await findRoutes(page)
    await page.waitFor('document.querySelector(".results .form-error")?.textContent === "No route found, also not through other chains."')
  })

  test('no route because a source failed names the source', async (t) => {
    const page = await transferScreen(t, standardWorld({ routesError: { status: 500, message: 'down' } }))
    await fillForm(page, { token: 'USDC', amount: '1' })
    await findRoutes(page)
    await page.waitFor('document.querySelector(".results .form-error")?.textContent === "No route found. lifi: li.quest responded 500: down"')
  })

  // ---- routes ----

  test('the routes are ranked with what arrives, the worst case, cost and time', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC', amount: '100' })
    await findRoutes(page)
    await routesShown(page)
    const cells = await page.evaluate<string[]>('[...document.querySelectorAll(".results table tbody tr:first-child > *")].map((c) => c.innerText.trim())')
    assert.deepEqual(cells.slice(1), ['lifi/stargate', '99.9 USDC', '99.4005', '$0.05', '$99.85', '60 s'])
  })

  test('a route through a stop-over names the chain it stops on', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@eth', tool: 'stargate', rate: 0.999 }, { from: 'USDC@eth', to: 'LINK@eth', tool: '1inch', rate: 0.0666 }], balances: { [ME]: { [`arb:${TOKENS.usdcArb.address}`]: '1000000000', [`eth:${'0x0000000000000000000000000000000000000000'}`]: '1000000000000000' } } })
    const page = await transferScreen(t, world)
    await fillForm(page, { token: 'USDC', amount: '100', toChain: 'eth', toToken: 'LINK' })
    await findRoutes(page)
    await routesShown(page)
    assert.equal(await page.text('.results .via-cell'), 'lifi/stargate > Ethereum > lifi/1inch')
  })

  test('a restricted route is tagged and explained', async (t) => {
    const page = await transferScreen(t, standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'across', rate: 0.999 }] }))
    await fillForm(page, { token: 'USDC', amount: '100' })
    await findRoutes(page)
    await routesShown(page)
    assert.deepEqual([await page.text('.results .via-cell .tag'), (await page.text('.route-detail')).includes('Uses Across, which restricts where it can be used.')], ['region', true])
  })

  test('choosing another route shows its details', async (t) => {
    const page = await transferScreen(t, standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 }, { from: 'USDC@arb', to: 'USDC@bas', tool: 'hop', rate: 0.99 }] }))
    await fillForm(page, { token: 'USDC', amount: '100' })
    await findRoutes(page)
    await routesShown(page)
    await page.click('input[name=route][value="1"]')
    await page.waitFor('document.querySelector(".route-detail").textContent.includes("via lifi/hop")')
  })

  // ---- confirming and sending ----

  const toReview = async (page: Page, amount = '100') => {
    await fillForm(page, { token: 'USDC', amount })
    await findRoutes(page)
    await routesShown(page)
    await page.click('button', 'Review and send')
    await page.waitFor('document.querySelector("dialog[open]") || document.querySelector(".results .form-error")')
  }

  test('the confirmation summarises the transfer under a real-money warning', async (t) => {
    const page = await transferScreen(t)
    await toReview(page)
    await page.waitFor('document.querySelector("dialog[open] .banner.real")')
    const rows = await page.evaluate<string[]>('[...document.querySelectorAll("dialog[open] dt")].map((d) => d.textContent + ": " + d.nextElementSibling.textContent)')
    assert.deepEqual(rows, ['You send: 100 USDC from Arbitrum', 'You receive: 99.9 USDC on Base', 'At worst: 99.4005 USDC', 'Gas and fees: $0.05', 'Route: lifi/stargate', 'Time: about 60 s', `Recipient: ${ME}`])
  })

  test('cancelling the confirmation sends nothing', async (t) => {
    const page = await transferScreen(t)
    await toReview(page)
    await page.waitFor('document.querySelector("dialog[open]")')
    await page.click('dialog[open] button', 'Cancel')
    await page.waitFor('!document.querySelector("dialog[open]")')
    assert.equal(sends(page), 0)
  })

  test('a confirmed transfer runs and ends with what arrived', async (t) => {
    const page = await transferScreen(t)
    await toReview(page)
    await page.click('dialog[open] button', 'Send now')
    await page.waitFor('document.querySelector(".job-result .banner.ok")', 30_000)
    assert.deepEqual([await page.text('.job-result'), await page.text('.statusbar .job-text'), sends(page)], ['Done. Received 99.9 USDC at 0x9858Ef…aEda94.', 'Transfer finished', 2])
  })

  test('the job view lists each step in its log, and Back returns to the form', async (t) => {
    const page = await transferScreen(t)
    await toReview(page)
    await page.click('dialog[open] button', 'Send now')
    await page.waitFor('document.querySelector(".job-result .banner")', 30_000)
    assert.equal((await page.text('ol.log')).includes('Signing and sending the transaction'), true)
    await page.click('button', 'Back')
    await page.waitFor('document.querySelector("#f-amount")')
  })

  test('a transfer whose transaction reverts stops and says to resume from History', async (t) => {
    const page = await transferScreen(t, standardWorld({ receipt: 'reverted' }))
    await toReview(page)
    await page.click('dialog[open] button', 'Send now')
    await page.waitFor('document.querySelector(".job-result .banner.err")', 30_000)
    assert.deepEqual([await page.text('.job-result'), await page.text('.statusbar .job-text')], ['Stopped at leg 1. Resume it from History once the cause is fixed.', '1 of 1 stopped'])
  })

  test('a restricted route needs the location confirmation before Send now works', async (t) => {
    const page = await transferScreen(t, standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'across', rate: 0.999 }] }))
    await toReview(page)
    await page.waitFor('document.querySelector("dialog[open] .geo")')
    const sendDisabled = () => page.evaluate('[...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Send now").disabled')
    assert.equal(await sendDisabled(), true)
    await page.click('#confirm-geo')
    assert.equal(await sendDisabled(), false)
  })

  test('on test networks the confirmation says only test funds move, and asks for no location', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arbs', to: 'USDC@bast', tool: 'across', rate: 0.999 }], balances: { [ME]: { [`arbs:${TOKENS.usdcArbs.address}`]: '1000000000', [`bast:${'0x0000000000000000000000000000000000000000'}`]: '1' } } })
    const page = await transferScreen(t, world, { prefs: { testMode: true, lastChain: 'arbs' } })
    await page.fill('#f-fromChain', 'arbs')
    await page.fill('#f-toChain', 'bast')
    await page.waitFor('document.querySelector("#held-note").textContent.includes("1,000 USDC")')
    await toReview(page)
    await page.waitFor('document.querySelector("dialog[open] .banner.test")')
    assert.deepEqual([await page.text('dialog[open] .banner'), await page.has('dialog[open] .geo')], ['Test networks: this moves test funds only.', false])
  })

  test('a transfer for more than the wallet holds is stopped at review', async (t) => {
    const page = await transferScreen(t)
    await toReview(page, '2000')
    await page.waitFor('document.querySelector(".results .form-error")?.textContent === "The wallet holds 1,000 USDC on Arbitrum, less than you want to send."')
  })

  test('a recipient without gas gets a top-up, shown in the confirmation', async (t) => {
    const world = standardWorld({ balances: { [ME]: { [`arb:${TOKENS.usdcArb.address}`]: '1000000000', [`arb:${'0x0000000000000000000000000000000000000000'}`]: '10000000000000000' } }, routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 }, { from: 'USDC@arb', to: 'ETH@bas', tool: 'stargate', rate: 0.000333 }] })
    const page = await transferScreen(t, world)
    await toReview(page)
    await page.waitFor('[...document.querySelectorAll("dialog[open] dt")].some((d) => d.textContent === "Gas top-up")')
    assert.equal(await page.evaluate('[...document.querySelectorAll("dialog[open] dt")].find((d) => d.textContent === "Gas top-up").nextElementSibling.textContent'), "0.9 USDC into Base's coin after the transfer (the recipient has none there)")
  })

  test('sending "all" says it sends the whole balance', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC', amount: 'all' })
    await findRoutes(page)
    await routesShown(page)
    await page.click('button', 'Review and send')
    await page.waitFor('document.querySelector("dialog[open] dd")?.textContent === "whole balance, now 1,000 USDC from Arbitrum"')
  })

  // ---- saving a route ----

  test('a route is saved under the name given', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC', amount: '100' })
    await findRoutes(page)
    await routesShown(page)
    await page.click('button', 'Save as route')
    await page.fill('#ask-text', 'weekly')
    await page.evaluate('document.querySelector("#ask-text").form.requestSubmit()')
    await page.waitFor('document.querySelector(".results .banner.ok")?.textContent === "Saved \\"weekly\\". Find it under Saved routes."')
    assert.equal(JSON.parse(await page.evaluate<string>('localStorage.getItem("chainer/routes/weekly.json")')).via, 'lifi/stargate')
  })

  test('saving a route without a name saves nothing', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC', amount: '100' })
    await findRoutes(page)
    await routesShown(page)
    await page.click('button', 'Save as route')
    await page.click('dialog[open] button', 'Cancel')
    await page.waitFor('!document.querySelector("dialog[open]")')
    assert.equal(await page.evaluate('Object.keys(localStorage).some((k) => k.startsWith("chainer/routes/"))'), false)
  })

  test('a route name that cannot be used is refused', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC', amount: '100' })
    await findRoutes(page)
    await routesShown(page)
    await page.click('button', 'Save as route')
    await page.fill('#ask-text', 'a/b')
    await page.evaluate('document.querySelector("#ask-text").form.requestSubmit()')
    await formError(page, '"a/b" is not a usable name: use letters, digits, dots, dashes or underscores')
  })

  // ---- the token picker ----

  const listed = { name: 'test list', tokens: [{ chainId: 990002, address: TOKENS.usdcArb.address, symbol: 'USDC', name: 'USD Coin' }, ...Array.from({ length: 10 }, (_, i) => ({ chainId: 990002, address: `0x${'b'.repeat(39)}${i}`, symbol: `L${i}`, name: `Listed ${i}` }))] }
  const pickerWorld = () => standardWorld({ tokenList: listed, tokens: [...Object.values(TOKENS), { chain: 'arb', symbol: 'USDC', address: '0x5555555555555555555555555555555555555555', decimals: 6, price: 1, name: 'Fake USD', status: 'unverified' }, { chain: 'arb', symbol: 'SCAM', address: '0x6666666666666666666666666666666666666666', decimals: 6, status: 'flagged' }] })
  const openPicker = async (page: Page) => {
    await page.evaluate('document.querySelector("#f-fromSymbol").focus()')
    await page.waitFor('!document.querySelector("#f-fromSymbol-list").hidden')
  }

  test('the token field opens with what the wallet holds, then the chain’s popular tokens', async (t) => {
    const page = await transferScreen(t, pickerWorld())
    await openPicker(page)
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#f-fromSymbol-list .combo-group")].map((g) => g.textContent)'), ['In your wallet'])
  })

  test('typing filters the tokens, with the listed one first, a look-alike tagged and both marked freezable', async (t) => {
    const page = await transferScreen(t, pickerWorld())
    await page.fill('#f-fromSymbol', 'usdc')
    await page.waitFor('document.querySelectorAll("#f-fromSymbol-list .combo-option").length === 2')
    const rows = await page.evaluate<string[]>('[...document.querySelectorAll("#f-fromSymbol-list .combo-option")].map((o) => o.querySelector(".sym").textContent + "|" + [...o.querySelectorAll(".tag")].map((t) => t.textContent).join(" "))')
    assert.deepEqual(rows, ['USDC|freezable', 'USDC|unchecked freezable'])
  })

  test('a token flagged as a scam is never offered', async (t) => {
    const page = await transferScreen(t, pickerWorld())
    await page.fill('#f-fromSymbol', 'scam')
    await page.waitFor('document.querySelector("#f-fromSymbol-list .combo-empty")')
    assert.equal(await page.text('#f-fromSymbol-list .combo-empty'), 'No token matches "scam" on Arbitrum.')
  })

  test('arrow keys and Enter pick a token into the field', async (t) => {
    const page = await transferScreen(t, pickerWorld())
    await page.fill('#f-fromSymbol', 'eth')
    await page.waitFor('document.querySelectorAll("#f-fromSymbol-list .combo-option").length > 0')
    await page.key('#f-fromSymbol', 'ArrowDown')
    await page.key('#f-fromSymbol', 'Enter')
    await page.waitFor('document.querySelector("#f-fromSymbol").value === "ETH" && document.querySelector("#f-fromSymbol-list").hidden')
  })

  test('Escape closes the token list', async (t) => {
    const page = await transferScreen(t, pickerWorld())
    await openPicker(page)
    await page.key('#f-fromSymbol', 'Escape')
    await page.waitFor('document.querySelector("#f-fromSymbol-list").hidden')
  })

  test('a picked look-alike is the token used, by its address, and warned about', async (t) => {
    const lookAlike = '0x5555555555555555555555555555555555555555'
    const page = await transferScreen(t, { ...pickerWorld(), routes: [{ from: `${lookAlike}@arb`, to: 'USDC@bas', tool: 'stargate', rate: 0.999 }] })
    await page.fill('#f-fromSymbol', 'usdc')
    await page.waitFor('document.querySelectorAll("#f-fromSymbol-list .combo-option").length === 2')
    await page.evaluate('document.querySelectorAll("#f-fromSymbol-list .combo-option")[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))')
    await page.fill('#f-amount', '1')
    await findRoutes(page)
    await routesShown(page)
    assert.equal((await page.text('.route-detail')).includes(`USDC on Arbitrum (${lookAlike}) is neither on the token list nor checked by LI.FI. Make sure it is the token you mean.`), true)
  })

  test('without a curated list, a token that passed screening gets no warning in the route details', async (t) => {
    const page = await transferScreen(t)
    await fillForm(page, { token: 'USDC', amount: '100' })
    await findRoutes(page)
    await routesShown(page)
    assert.equal((await page.text('.route-detail')).includes('token list'), false)
  })

  test('without a curated list, a token nobody checked is still warned about', async (t) => {
    const odd = '0x5555555555555555555555555555555555555555'
    const world = standardWorld({ tokens: [...Object.values(TOKENS), { chain: 'arb', symbol: 'ODD', address: odd, decimals: 6, price: 1, status: 'unverified' }], routes: [{ from: `${odd}@arb`, to: 'USDC@bas', tool: 'stargate', rate: 0.999 }] })
    const page = await transferScreen(t, world)
    await fillForm(page, { token: 'ODD', amount: '1', toToken: 'USDC' })
    await findRoutes(page)
    await routesShown(page)
    assert.equal((await page.text('.route-detail')).includes(`ODD on Arbitrum (${odd}) is neither on the token list nor checked by LI.FI.`), true)
  })

  test('the token list that could not be loaded is mentioned in the picker', async (t) => {
    const page = await transferScreen(t)
    await openPicker(page)
    assert.equal(await page.text('#f-fromSymbol-list .combo-empty'), "The token list could not be loaded (tokens.uniswap.org responded 404: not found); tokens are judged by LI.FI's screening only")
  })

  // ---- unfinished transfers ----

  const unfinished = () => ({
    'chainer/pipelines/stuck.json': JSON.stringify({ id: 'stuck', createdAt: '2026-11-26T10:00:00.000Z', wallet: 'main', fromAddress: ME, state: 'failed', geoAccepted: [], legs: [{ from: { ...TOKENS.usdcArb, chainKey: 'arb' }, to: { ...TOKENS.usdcBas, chainKey: 'bas' }, amount: '100000000', toAddress: ME, state: 'failed', error: 'rpc down' }] }),
  })

  test('an unfinished transfer is offered for resuming, and resuming runs it to the end', async (t) => {
    const page = await transferScreen(t, standardWorld(), { storage: unfinished() })
    await page.waitFor('document.querySelector(".unfinished li")')
    await page.click('.unfinished button', 'Resume')
    await page.waitFor('document.querySelector(".job-result .banner.ok")', 30_000)
    assert.equal(await page.text('.job-result'), 'Done. Received 99.9 USDC at 0x9858Ef…aEda94.')
  })

  test('resuming a run that used a restricted bridge asks for the location first', async (t) => {
    const stuck = JSON.parse(unfinished()['chainer/pipelines/stuck.json'])
    const page = await transferScreen(t, standardWorld(), { storage: { 'chainer/pipelines/stuck.json': JSON.stringify({ ...stuck, geoAccepted: ['across'] }) } })
    await page.waitFor('document.querySelector(".unfinished li")')
    await page.click('.unfinished button', 'Resume')
    await page.waitFor('document.querySelector("dialog[open] #geo-again")')
    await page.click('#geo-again')
    await page.click('dialog[open] button', 'Resume')
    await page.waitFor('document.querySelector(".job-result .banner.ok")', 30_000)
  })
})
