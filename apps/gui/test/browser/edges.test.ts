// The GUI's remaining paths in headless Chromium against the fake network: History with runs,
// stop-over gas, failures inside runs, flagged tokens typed by hand, test-network saved routes and a failed start.
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { browserMissing, lazyBrowser, ME, setUpApp, unlock, type Page } from './harness.ts'
import { standardWorld, TOKENS } from './worlds.ts'
import type { World, WorldRoute } from '../../../../testing/fakenet/world.ts'

const b = lazyBrowser()
after(() => b.close())

const ZERO = '0x0000000000000000000000000000000000000000'
async function appAt(t: { after: (fn: () => Promise<void>) => void }, label: string, world: World = standardWorld(), opts: { storage?: Record<string, string>; prefs?: Record<string, unknown>; settings?: Record<string, unknown> } = {}): Promise<Page> {
  const page = await b.page(world)
  t.after(async () => {
    assert.deepEqual(page.unexpected, [], 'the page asked for something the fake network does not know')
    assert.deepEqual(page.errors, [], 'the page had uncaught errors')
    await page.close()
  })
  await page.open({ ...(await setUpApp({ lastChain: 'arb', ...opts.prefs }, opts.settings)), ...opts.storage })
  await unlock(page)
  await page.click('.sheetlist button', label)
  await page.waitFor(`document.querySelector(".sheetlist [aria-current]")?.textContent === ${JSON.stringify(label)} && document.querySelector("#sheet .sheet-title")`)
  return page
}
const run = (id: string, state: 'done' | 'failed', extra: Record<string, unknown> = {}) => ({
  [`chainer/pipelines/${id}.json`]: JSON.stringify({ id, createdAt: '2026-11-26T10:00:00.000Z', wallet: 'main', fromAddress: ME, state, geoAccepted: [], legs: [{ from: { ...TOKENS.usdcArb, chainKey: 'arb' }, to: { ...TOKENS.usdcBas, chainKey: 'bas' }, amount: '100000000', toAddress: ME, state, received: state === 'done' ? '99900000' : undefined, error: state === 'failed' ? 'rpc down' : undefined, ...extra }] }),
})
/** USDC Arbitrum -> LINK Ethereum through USDC on Ethereum, where the wallet has no ETH. */
const viaEthereum = (routes: WorldRoute[] = [{ from: 'USDC@arb', to: 'USDC@eth', tool: 'stargate', rate: 0.999 }, { from: 'USDC@eth', to: 'LINK@eth', tool: '1inch', rate: 0.0666 }, { from: 'USDC@arb', to: 'ETH@eth', tool: 'stargate', rate: 0.000333 }]) =>
  standardWorld({ balances: { [ME]: { [`arb:${TOKENS.usdcArb.address}`]: '1000000000', [`arb:${ZERO}`]: '10000000000000000' } }, routes })
const toLinkOnEthereum = async (page: Page) => {
  await page.fill('#f-fromSymbol', 'USDC')
  await page.fill('#f-amount', '100')
  await page.fill('#f-toChain', 'eth')
  await page.fill('#f-toSymbol', 'LINK')
  await page.evaluate('document.querySelector("#f-amount").form.requestSubmit()')
  await page.waitFor('document.querySelectorAll("input[name=route]").length > 0')
  await page.click('button', 'Review and send')
}

describe('remaining GUI paths', { concurrency: 6, skip: browserMissing }, () => {
  // ---- history ----

  test('History lists runs with what arrived and offers Resume only for unfinished ones', async (t) => {
    const page = await appAt(t, 'History', standardWorld(), { storage: { ...run('ok', 'done'), ...run('stuck', 'failed') } })
    await page.waitFor('document.querySelectorAll("#sheet table.data tbody tr").length === 2')
    // innerText, as shown: a stopped run's reason sits on its own line.
    const rows = await page.evaluate<string[]>('[...document.querySelectorAll("#sheet table.data tbody tr")].map((r) => r.querySelector("th").innerText + "|" + (r.querySelector("button")?.textContent ?? "-"))')
    assert.deepEqual(rows.sort(), ['100 USDC on Arbitrum to USDC on Base received 99.9 USDC|-', '100 USDC on Arbitrum to USDC on Base\nrpc down|Resume'].sort())
  })

  test('a run resumed from History finishes', async (t) => {
    const page = await appAt(t, 'History', standardWorld(), { storage: run('stuck', 'failed') })
    await page.waitFor('document.querySelector("#sheet table.data button")')
    await page.click('#sheet table.data button', 'Resume')
    await page.waitFor('document.querySelector(".job-result .banner.ok")', 30_000)
  })

  // ---- stop-over gas in the GUI ----

  test('a route stopping on a chain without gas shows the gas sent ahead in the confirmation', async (t) => {
    const page = await appAt(t, 'Transfer', viaEthereum())
    await toLinkOnEthereum(page)
    await page.waitFor('[...document.querySelectorAll("dialog[open] dt")].some((d) => d.textContent === "Gas ahead")', 30_000)
  })

  test('the gas is sent ahead first, then the route runs', async (t) => {
    // The fake chains do not move funds, so the USDC the first leg delivers on Ethereum is put there up front.
    const world = viaEthereum()
    world.balances![ME]![`eth:${TOKENS.usdcEth.address}`] = '99900000'
    const page = await appAt(t, 'Transfer', world)
    await toLinkOnEthereum(page)
    await page.waitFor('document.querySelector("dialog[open]")', 30_000)
    await page.click('dialog[open] button', 'Send now')
    await page.waitFor('document.querySelector(".job-result .banner.ok")', 30_000)
    assert.equal((await page.text('ol.log')).includes('Gas for eth:'), true)
  })

  test('stop-over gas without a route to the chain’s coin stops at review with the reason', async (t) => {
    const page = await appAt(t, 'Transfer', viaEthereum(viaEthereum().routes!.slice(0, 2)))
    await toLinkOnEthereum(page)
    await page.waitFor('document.querySelector(".results .form-error")?.textContent.startsWith("No direct route to send gas ahead to Ethereum")', 30_000)
  })

  test('stop-over gas that cannot be priced stops at review with the reason', async (t) => {
    const world = viaEthereum([{ from: 'USDC@arb', to: 'USDC@eth', tool: 'stargate', rate: 0.999 }, { from: 'USDC@eth', to: 'LINK@eth', tool: '1inch', rate: 0.0666, gasUsd: 0 }])
    world.chains = world.chains.map((c) => (c.key === 'eth' ? { ...c, price: undefined } : c))
    const page = await appAt(t, 'Transfer', world)
    await toLinkOnEthereum(page)
    await page.waitFor('document.querySelector(".results .form-error")?.textContent.startsWith("Cannot send gas ahead to Ethereum: the gas price of the destination chain is unknown")', 30_000)
  })

  test('stop-over gas the wallet cannot pay on top stops at review', async (t) => {
    const world = viaEthereum()
    world.balances = { [ME]: { [`arb:${TOKENS.usdcArb.address}`]: '100000000', [`arb:${ZERO}`]: '10000000000000000' } }
    const page = await appAt(t, 'Transfer', world)
    await toLinkOnEthereum(page)
    await page.waitFor('document.querySelector(".results .form-error")?.textContent.startsWith("The wallet cannot pay the gas for Ethereum")', 30_000)
  })

  test('stop-over gas that does not arrive stops the run before the route starts', async (t) => {
    const page = await appAt(t, 'Transfer', { ...viaEthereum(), receipt: 'reverted' })
    await toLinkOnEthereum(page)
    await page.waitFor('document.querySelector("dialog[open]")', 30_000)
    await page.click('dialog[open] button', 'Send now')
    await page.waitFor('document.querySelector(".job-result .banner.err")?.textContent.includes("The gas for eth did not arrive, so the main transfer was not started")', 30_000)
  })

  test('a top-up whose route search fails is left out, and the confirmation says so next to the freeze warning for USDC', async (t) => {
    // ETH is on the avoid list, so the search for the top-up into ETH refuses outright.
    const world = standardWorld({ balances: { [ME]: { [`arb:${TOKENS.usdcArb.address}`]: '1000000000', [`arb:${ZERO}`]: '10000000000000000' } } })
    const page = await appAt(t, 'Transfer', world, { settings: { avoidTokens: ['ETH'] } })
    await page.fill('#f-fromSymbol', 'USDC')
    await page.fill('#f-amount', '100')
    await page.evaluate('document.querySelector("#f-amount").form.requestSubmit()')
    await page.waitFor('document.querySelectorAll("input[name=route]").length > 0')
    await page.click('button', 'Review and send')
    await page.waitFor('document.querySelector("dialog[open]")', 45_000)
    const notes = await page.evaluate<string[]>('[...document.querySelectorAll("dialog[open] .hint")].map((p) => p.textContent)')
    assert.deepEqual(notes, ['You receive USDC on Base. Its issuer can freeze or blacklist addresses, which would lock the funds there.', 'No gas top-up: no route for it (ETH is on your list of tokens to avoid).'])
  })

  // ---- flagged tokens typed by hand ----

  const flaggedWorld = () => standardWorld({ tokens: [...Object.values(TOKENS), { chain: 'arb', symbol: 'SCAM', address: '0x6666666666666666666666666666666666666666', decimals: 6, status: 'flagged' }] })

  test('a flagged token typed by its symbol is refused', async (t) => {
    const page = await appAt(t, 'Transfer', flaggedWorld())
    await page.fill('#f-fromSymbol', 'SCAM')
    await page.fill('#f-amount', '1')
    await page.evaluate('document.querySelector("#f-amount").form.requestSubmit()')
    await page.waitFor('document.querySelector(".transfer-form .form-error").textContent === "SCAM on Arbitrum is flagged by LI.FI’s token screening as a likely scam, so it is not sent from here."')
  })

  test('a flagged token typed by its address is refused', async (t) => {
    const page = await appAt(t, 'Transfer', flaggedWorld())
    await page.fill('#f-fromSymbol', '0x6666666666666666666666666666666666666666')
    await page.fill('#f-amount', '1')
    await page.evaluate('document.querySelector("#f-amount").form.requestSubmit()')
    await page.waitFor('document.querySelector(".transfer-form .form-error").textContent === "SCAM on Arbitrum is flagged by LI.FI’s token screening as a likely scam, so it is not sent from here."')
  })

  test('a token typed by an address LI.FI finds but does not list is used, with a warning', async (t) => {
    const odd = { chain: 'arb', symbol: 'ODD', address: '0x8888888888888888888888888888888888888888', decimals: 6, price: 1, status: 'unverified' as const }
    const page = await appAt(t, 'Transfer', standardWorld({ unlisted: [odd], routes: [{ from: `${odd.address}@arb`, to: 'USDC@bas', tool: 'stargate', rate: 0.999 }] }))
    await page.fill('#f-fromSymbol', odd.address)
    await page.fill('#f-amount', '1')
    await page.fill('#f-toSymbol', 'USDC')
    await page.evaluate('document.querySelector("#f-amount").form.requestSubmit()')
    await page.waitFor('document.querySelectorAll("input[name=route]").length > 0')
    assert.equal((await page.text('.route-detail')).includes(`ODD on Arbitrum (${odd.address}) is neither on the token list nor checked by LI.FI.`), true)
  })

  test('stop-over gas whose search is refused stops at review with the reason', async (t) => {
    // ETH is avoided, so the search for gas (ETH on the stop-over chain) refuses outright; the route itself avoids no token.
    const page = await appAt(t, 'Transfer', viaEthereum(), { settings: { avoidTokens: ['ETH'] } })
    await toLinkOnEthereum(page)
    await page.waitFor('document.querySelector(".results .form-error")?.textContent === "Cannot send gas ahead to Ethereum: ETH is on your list of tokens to avoid. Turn the gas top-up off in Settings or get some ETH there first."', 30_000)
  })

  // ---- refusals inside other screens ----

  test('a sweep saved under a name that cannot be used is refused', async (t) => {
    const page = await appAt(t, 'Bridge wallet', standardWorld())
    await page.click('button', 'Show tokens')
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('button', 'Plan the sweep')
    await page.waitFor('document.querySelector("#sheet .results h2")', 30_000)
    await page.click('#sheet .results button', 'Save as route')
    await page.fill('#ask-text', 'a/b')
    await page.evaluate('document.querySelector("#ask-text").form.requestSubmit()')
    await page.waitFor('document.querySelector("#sheet .form-error").textContent === "\\"a/b\\" is not a usable name: use letters, digits, dots, dashes or underscores"')
  })

  test('a pipeline that cannot be run says why instead of starting', async (t) => {
    const page = await appAt(t, 'Pipelines')
    await page.fill('[aria-label="Leg 1 amount"]', 'all')
    await page.click('#sheet button', 'Review and run')
    await page.waitFor('document.querySelector("#sheet .form-error").textContent === "Leg 1 needs an amount; later legs can send \\"all\\" of what arrived"')
  })

  // ---- test networks for saved routes ----

  test('a saved route runs on the test networks of its chains in test mode', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arbs', to: 'USDC@bast', tool: 'stargate', rate: 0.999 }], balances: { [ME]: { [`arbs:${TOKENS.usdcArbs.address}`]: '1000000000', [`bast:${ZERO}`]: '1' } } })
    const saved = { 'chainer/routes/nightly.json': JSON.stringify({ kind: 'transfer', name: 'nightly', createdAt: '2026-11-26T00:00:00.000Z', wallet: 'main', from: 'USDC@arb', to: 'USDC@bas', amount: '100000000', via: 'lifi/stargate', fallback: false }) }
    const page = await appAt(t, 'Saved routes', world, { storage: saved, prefs: { testMode: true, lastChain: 'arbs' } })
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Run')
    await page.waitFor('document.querySelector("dialog[open] dd")?.textContent === "100 USDC from Arbitrum Sepolia"', 30_000)
  })

  test('a saved sweep from a chain without a test network says so in test mode', async (t) => {
    const saved = { 'chainer/routes/tidy.json': JSON.stringify({ kind: 'sweep', name: 'tidy', createdAt: '2026-11-26T00:00:00.000Z', wallet: 'main', fromChain: 'ltc', toChain: 'bas' }) }
    const page = await appAt(t, 'Saved routes', standardWorld(), { storage: saved, prefs: { testMode: true } })
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Run')
    await page.waitFor('document.querySelector("#sheet .form-error")?.textContent === "Litecoin has no test network here, so it cannot be tested with test funds"')
  })

  // ---- a failed start ----

  test('an app that cannot start says why instead of showing a blank window', async (t) => {
    const page = await b.page(standardWorld())
    t.after(() => page.close())
    await page.open({ ...(await setUpApp()), 'chainer/settings.json': '{"slippage":' })
    await page.waitFor('document.querySelector("#app").textContent.startsWith("chainer could not start: The settings file (settings.json) is damaged")')
  })
})
