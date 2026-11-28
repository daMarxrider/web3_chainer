// Bridge wallet, Saved routes, Pipelines, Schedules and the in-app scheduler, in headless Chromium
// against the fake network.
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { browserMissing, lazyBrowser, ME, setUpApp, unlock, type Page } from './harness.ts'
import { standardWorld, TOKENS } from './worlds.ts'
import type { World } from '../../../../testing/fakenet/world.ts'

const b = lazyBrowser()
after(() => b.close())

async function screen(t: { after: (fn: () => Promise<void>) => void }, label: string, world: World = standardWorld(), storage: Record<string, string> = {}, prefs: Record<string, unknown> = {}): Promise<Page> {
  const page = await b.page(world)
  t.after(async () => {
    assert.deepEqual(page.unexpected, [], 'the page asked for something the fake network does not know')
    assert.deepEqual(page.errors, [], 'the page had uncaught errors')
    await page.close()
  })
  await page.open({ ...(await setUpApp({ lastChain: 'arb', ...prefs })), ...storage })
  await unlock(page)
  await page.click('.sheetlist button', label)
  await page.waitFor(`document.querySelector("#sheet .sheet-title")?.textContent.length > 0 && document.querySelector(".sheetlist [aria-current]")?.textContent === ${JSON.stringify(label)}`)
  return page
}
const sweepWorld = (over: Partial<World> = {}) =>
  standardWorld({
    routes: [
      { from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 },
      { from: 'ETH@arb', to: 'ETH@bas', tool: 'stargate', rate: 0.999, gasUsd: 0.05 },
    ],
    ...over,
  })
const errorIs = (page: Page, text: string) => page.waitFor(`document.querySelector("#sheet .form-error")?.textContent === ${JSON.stringify(text)}`)
const savedRoute = (over: Record<string, unknown> = {}) => ({ 'chainer/routes/nightly.json': JSON.stringify({ kind: 'transfer', name: 'nightly', createdAt: '2026-11-26T00:00:00.000Z', wallet: 'main', from: 'USDC@arb', to: 'USDC@bas', amount: '100000000', via: 'lifi/stargate', fallback: false, ...over }) })
const savedSweep = () => ({ 'chainer/routes/tidy.json': JSON.stringify({ kind: 'sweep', name: 'tidy', createdAt: '2026-11-26T00:00:00.000Z', wallet: 'main', fromChain: 'arb', toChain: 'bas', tokens: ['USDC'] }) })
const schedule = (route: string, trigger: unknown, geoAccepted: string[] = []) => ({ [`chainer/schedules/s-${route}.json`]: JSON.stringify({ id: `s-${route}`, route, trigger, geoAccepted, createdAt: '2026-11-26T00:00:00.000Z' }) })

describe('workflows', { concurrency: 6, skip: browserMissing }, () => {
  // ---- Bridge wallet ----

  const showTokens = async (page: Page) => {
    await page.click('button', 'Show tokens')
    await page.waitFor('document.querySelector("#sheet table.data") || document.querySelector("#sheet .empty:not(.busy)")')
  }

  test('planning waits for the token list, and says so', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld())
    assert.deepEqual([await page.evaluate('[...document.querySelectorAll("button")].find((b) => b.textContent === "Plan the sweep").disabled'), await page.text('#sw-plan-hint')], [true, 'Press Show tokens first, then tick the tokens to move.'])
  })

  test('the tokens held are listed, all ticked', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld())
    await showTokens(page)
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#sheet table.data tbody tr")].map((r) => r.querySelector("th").textContent + ":" + r.querySelector("input").checked)'), ['USDC:true', 'ETH:true'])
  })

  test('the select-all box unticks every token, and planning then asks for one', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld())
    await showTokens(page)
    await page.click('#sheet table.data thead input')
    await page.click('button', 'Plan the sweep')
    await errorIs(page, 'Tick at least one token')
  })

  test('a chain with nothing on it says so, and planning stays off with the reason', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld({ balances: {} }))
    await showTokens(page)
    assert.deepEqual([await page.text('#sheet .table-wrap .empty'), await page.text('#sw-plan-hint')], ['This wallet holds no tokens on that chain.', 'Nothing to move: the wallet holds no tokens on the chain you send from.'])
  })

  test('balances that cannot be read are reported', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld({ tokensError: { status: 500, message: 'down' } }))
    await page.click('button', 'Show tokens')
    await errorIs(page, 'li.quest responded 500: down')
  })

  test('the same chain on both sides is refused', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld())
    await showTokens(page)
    await page.fill('#sw-to', 'arb')
    await page.click('button', 'Plan the sweep')
    await errorIs(page, 'Pick two different chains')
  })

  test('choosing another source chain clears the token list', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld())
    await showTokens(page)
    await page.fill('#sw-from', 'eth')
    await page.waitFor('!document.querySelector("#sheet table.data") && document.querySelector("#sw-plan-hint").textContent.startsWith("Press Show tokens")')
  })

  const planned = async (page: Page) => {
    await showTokens(page)
    await page.click('button', 'Plan the sweep')
    await page.waitFor('document.querySelector("#sheet .results h2") || document.querySelector("#sheet .form-error")?.textContent')
  }

  test('the plan lists one transfer per token and what was skipped', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 }] }))
    await planned(page)
    assert.deepEqual([await page.evaluate('[...document.querySelectorAll("#sheet .results table tbody th")].map((x) => x.textContent)'), await page.evaluate('[...document.querySelectorAll("#sheet .results ul li")].map((x) => x.textContent)')], [['USDC'], ['ETH: no route']])
  })

  test('a plan that receives USDC warns once that its issuer can freeze it, in the plan and the confirmation', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 }] }))
    await planned(page)
    const warning = 'You receive USDC on Base. Its issuer can freeze or blacklist addresses, which would lock the funds there.'
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#sheet .results .notice")].map((x) => x.textContent.trim())'), [warning])
    await page.click('#sheet .results button', 'Review and send')
    await page.waitFor('document.querySelector("dialog[open]")')
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("dialog[open] .hint")].map((p) => p.textContent)'), [warning, '1 token is skipped (see the plan).'])
  })

  test('a plan where nothing can go says so', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld({ routes: [] }))
    await planned(page)
    assert.equal(await page.text('#sheet .results .empty'), 'No token can be bridged.')
  })

  test('a target token the destination does not have is refused', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld())
    await showTokens(page)
    await page.fill('#sw-target', 'XYZ')
    await page.click('button', 'Plan the sweep')
    await errorIs(page, 'There is no token "XYZ" on Base.')
  })

  test('a confirmed sweep runs one transfer per token, each to its end', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld())
    await planned(page)
    await page.click('#sheet .results button', 'Review and send')
    await page.waitFor('document.querySelector("dialog[open]")')
    await page.click('dialog[open] button', 'Send all')
    await page.waitFor('document.querySelectorAll(".job-result .banner.ok").length === 2', 30_000)
    assert.equal(await page.text('.statusbar .job-text'), 'All transfers finished')
  })

  test('a sweep is saved as a route', async (t) => {
    const page = await screen(t, 'Bridge wallet', sweepWorld())
    await planned(page)
    await page.click('#sheet .results button', 'Save as route')
    await page.fill('#ask-text', 'tidy')
    await page.evaluate('document.querySelector("#ask-text").form.requestSubmit()')
    await page.waitFor('document.querySelector("#sheet .results .banner.ok")?.textContent === "Saved \\"tidy\\". Find it under Saved routes."')
    assert.deepEqual(JSON.parse(await page.evaluate<string>('localStorage.getItem("chainer/routes/tidy.json")')).tokens, ['USDC', 'ETH'])
  })

  // ---- Saved routes ----

  test('without saved routes the screen says where they come from', async (t) => {
    const page = await screen(t, 'Saved routes')
    await page.waitFor('document.querySelector("#sheet .empty")?.textContent.startsWith("No saved routes yet.")')
  })

  test('saved routes are listed with what they do', async (t) => {
    const page = await screen(t, 'Saved routes', standardWorld(), { ...savedRoute(), ...savedSweep() })
    await page.waitFor('document.querySelectorAll("#sheet table.data tbody tr").length === 2')
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#sheet table.data tbody tr")].map((r) => r.querySelector("td").textContent)'), ['Fixed amount of USDC@arb to USDC@bas via lifi/stargate', 'Sweep arb to bas of USDC'])
  })

  test('a saved route runs after one confirmation', async (t) => {
    const page = await screen(t, 'Saved routes', standardWorld(), savedRoute())
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Run')
    await page.waitFor('document.querySelector("dialog[open]")')
    await page.click('dialog[open] button', 'Run now')
    await page.waitFor('document.querySelector(".job-result .banner.ok")', 30_000)
  })

  test('declining a saved route’s run goes back to the list', async (t) => {
    const page = await screen(t, 'Saved routes', standardWorld(), savedRoute())
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Run')
    await page.waitFor('document.querySelector("dialog[open]")')
    await page.click('dialog[open] button', 'Cancel')
    await page.waitFor('document.querySelector("#sheet table.data")')
  })

  test('a saved route whose path is gone says so, with a way back', async (t) => {
    const page = await screen(t, 'Saved routes', standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'hop', rate: 0.99 }] }), savedRoute())
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Run')
    await errorIs(page, 'The saved path "lifi/stargate" is no longer offered. Run it again with the fallback allowed, or save a new route.')
    await page.click('#sheet button', 'Back')
    await page.waitFor('document.querySelector("#sheet table.data")')
  })

  test('a saved route that falls back says so in the confirmation', async (t) => {
    const page = await screen(t, 'Saved routes', standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'hop', rate: 0.99 }] }), savedRoute({ fallback: true }))
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Run')
    await page.waitFor('document.querySelector("dialog[open] .hint")?.textContent === "The saved path \\"lifi/stargate\\" is no longer offered; this uses the best route now."')
  })

  test('a saved sweep is planned and confirmed like the Bridge wallet', async (t) => {
    const page = await screen(t, 'Saved routes', sweepWorld(), savedSweep())
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Run')
    await page.waitFor('document.querySelector("dialog[open]")?.textContent.includes("Confirm sweep")')
  })

  test('a saved sweep with nothing to move says so, with a way back', async (t) => {
    const page = await screen(t, 'Saved routes', sweepWorld({ balances: {} }), savedSweep())
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Run')
    await page.waitFor('document.querySelector("#sheet .empty")?.textContent === "Nothing to send."')
    await page.click('#sheet button', 'Back')
    await page.waitFor('document.querySelector("#sheet table.data")')
  })

  test('a removed saved route is gone', async (t) => {
    const page = await screen(t, 'Saved routes', standardWorld(), savedRoute())
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Remove')
    await page.waitFor('document.querySelector("#sheet .empty")?.textContent.startsWith("No saved routes yet.")')
  })

  // ---- Pipelines ----

  const legField = (n: number, label: string) => `[aria-label="Leg ${n} ${label}"]`

  test('the pipeline starts with one leg, and a leg can be added and removed', async (t) => {
    const page = await screen(t, 'Pipelines')
    await page.click('#sheet button', 'Add a leg')
    await page.waitFor('document.querySelectorAll(".leg-forms fieldset").length === 2')
    await page.click('#sheet button', 'Remove leg')
    await page.waitFor('document.querySelectorAll(".leg-forms fieldset").length === 1')
  })

  test('a dry run quotes each leg with what the one before would deliver at worst', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 }, { from: 'USDC@bas', to: 'ETH@bas', tool: 'uniswap', rate: 0.000333 }] })
    const page = await screen(t, 'Pipelines', world)
    await page.fill(legField(1, 'amount'), '100')
    await page.click('#sheet button', 'Add a leg')
    await page.fill(legField(2, 'token to receive'), 'ETH')
    await page.fill(legField(2, 'to chain'), 'bas')
    await page.click('#sheet button', 'Dry run')
    await page.waitFor('document.querySelectorAll("#sheet .results tbody tr").length === 2', 30_000)
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#sheet .results tbody tr")].map((r) => r.children[2].textContent)'), ['99.9 USDC', '0.0331 ETH'])
  })

  test('a first leg sending "all" is refused', async (t) => {
    const page = await screen(t, 'Pipelines')
    await page.fill(legField(1, 'amount'), 'all')
    await page.click('#sheet button', 'Dry run')
    await errorIs(page, 'Leg 1 needs an amount; later legs can send "all" of what arrived')
  })

  test('a later leg with an amount of its own is refused', async (t) => {
    const page = await screen(t, 'Pipelines')
    await page.fill(legField(1, 'amount'), '100')
    await page.click('#sheet button', 'Add a leg')
    await page.fill(legField(2, 'amount'), '5')
    await page.click('#sheet button', 'Dry run')
    await errorIs(page, 'Leg 2 must send "all": it continues with what the previous leg delivered')
  })

  test('a later leg starting on another chain than the previous one ended on is refused', async (t) => {
    const page = await screen(t, 'Pipelines')
    await page.fill(legField(1, 'amount'), '100')
    await page.click('#sheet button', 'Add a leg')
    await page.fill(legField(2, 'from chain'), 'eth')
    await page.click('#sheet button', 'Dry run')
    await errorIs(page, 'Leg 2 must start on the chain leg 1 ends on')
  })

  test('a leg without a token is refused', async (t) => {
    const page = await screen(t, 'Pipelines')
    await page.fill(legField(1, 'token to send'), '')
    await page.click('#sheet button', 'Dry run')
    await errorIs(page, 'Leg 1 needs a token to send and a token to receive')
  })

  test('a leg without any route is reported by number', async (t) => {
    const page = await screen(t, 'Pipelines', standardWorld({ routes: [] }))
    await page.fill(legField(1, 'amount'), '100')
    await page.click('#sheet button', 'Dry run')
    await errorIs(page, 'Leg 1 has no route')
  })

  test('a pipeline runs after the confirmation and the location question', async (t) => {
    const page = await screen(t, 'Pipelines')
    await page.fill(legField(1, 'amount'), '100')
    await page.click('#sheet button', 'Review and run')
    await page.waitFor('document.querySelector("dialog[open]")?.textContent.includes("Run plan")')
    await page.click('dialog[open] button', 'Continue')
    await page.waitFor('document.querySelector("dialog[open] #loc-ok")')
    await page.click('#loc-ok')
    await page.click('dialog[open] button', 'Confirm')
    await page.waitFor('document.querySelector(".job-result .banner.ok")', 30_000)
  })

  test('declining the location question still runs the pipeline, without restricted bridges', async (t) => {
    const page = await screen(t, 'Pipelines')
    await page.fill(legField(1, 'amount'), '100')
    await page.click('#sheet button', 'Review and run')
    await page.waitFor('document.querySelector("dialog[open]")')
    await page.click('dialog[open] button', 'Continue')
    await page.waitFor('document.querySelector("dialog[open] #loc-ok")')
    await page.click('dialog[open] button', 'Decline')
    await page.waitFor('document.querySelector(".job-result .banner.ok")', 30_000)
  })

  // ---- Schedules ----

  test('without saved routes there is nothing to schedule', async (t) => {
    const page = await screen(t, 'Schedules')
    await page.waitFor('document.querySelector("#sheet fieldset .empty")?.textContent === "There are no saved routes to schedule yet."')
  })

  test('each kind of schedule shows its own fields', async (t) => {
    const page = await screen(t, 'Schedules', standardWorld(), savedRoute())
    const fields = () => page.evaluate<string[]>('[...document.querySelectorAll("#sheet form .form [data-for], #sheet form .form .check")].map((r) => r.querySelector("input").id)')
    const at = await fields()
    await page.fill('#sc-kind', 'every')
    const every = await fields()
    await page.fill('#sc-kind', 'when')
    assert.deepEqual([at, every, await fields()], [['sc-at'], ['sc-every', 'sc-start'], ['sc-fees', 'sc-check', 'sc-repeat']])
  })

  const submitSchedule = (page: Page) => page.evaluate('document.querySelector("#sc-route").form.requestSubmit()')

  test('a one-time schedule needs a time', async (t) => {
    const page = await screen(t, 'Schedules', standardWorld(), savedRoute())
    await submitSchedule(page)
    await errorIs(page, 'Choose a time')
  })

  test('a repeat that is not a duration is refused', async (t) => {
    const page = await screen(t, 'Schedules', standardWorld(), savedRoute())
    await page.fill('#sc-kind', 'every')
    await page.fill('#sc-every', 'weekly')
    await submitSchedule(page)
    await errorIs(page, '"weekly" is not a duration; use a number and s, m, h or d, e.g. 30m, 6h, 1d')
  })

  test('a fee condition needs a dollar amount', async (t) => {
    const page = await screen(t, 'Schedules', standardWorld(), savedRoute())
    await page.fill('#sc-kind', 'when')
    await page.fill('#sc-fees', '0')
    await submitSchedule(page)
    await errorIs(page, 'Give the highest total gas and fees in dollars')
  })

  test('a new schedule asks for the location and is listed', async (t) => {
    const page = await screen(t, 'Schedules', standardWorld(), savedRoute())
    await page.fill('#sc-kind', 'every')
    await submitSchedule(page)
    await page.waitFor('document.querySelector("dialog[open] #loc-ok")')
    await page.click('#loc-ok')
    await page.click('dialog[open] button', 'Confirm')
    await page.waitFor('document.querySelector("#sheet table.data tbody td")?.textContent === "every 24 h"')
  })

  test('a fee condition is listed with its limit and interval', async (t) => {
    const page = await screen(t, 'Schedules', standardWorld(), savedRoute())
    await page.fill('#sc-kind', 'when')
    await page.fill('#sc-fees', '0.5')
    await page.click('#sc-repeat')
    await submitSchedule(page)
    await page.waitFor('document.querySelector("dialog[open]")')
    await page.click('dialog[open] button', 'Decline')
    await page.waitFor('document.querySelector("#sheet table.data tbody td")?.textContent.startsWith("when gas and fees are at most $0.50 (checked every 30 min")')
  })

  test('a one-time schedule is listed with its time', async (t) => {
    const page = await screen(t, 'Schedules', standardWorld(), savedRoute())
    await page.fill('#sc-at', '2099-01-01T10:00')
    await submitSchedule(page)
    await page.waitFor('document.querySelector("dialog[open]")')
    await page.click('dialog[open] button', 'Decline')
    await page.waitFor('document.querySelector("#sheet table.data tbody td")?.textContent.startsWith("once, ")')
  })

  test('a removed schedule is gone', async (t) => {
    const page = await screen(t, 'Schedules', standardWorld(), { ...savedRoute(), ...schedule('nightly', { kind: 'at', at: '2099-01-01T00:00:00.000Z' }) })
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Remove')
    await page.waitFor('document.querySelector("#sheet .table-wrap .empty")?.textContent === "No schedules yet."')
  })

  // ---- the in-app scheduler ----

  const resultOf = (page: Page, id: string) => page.evaluate<string | undefined>(`JSON.parse(localStorage.getItem("chainer/schedules/${id}.json") || "{}").lastResult`)
  const opened = async (t: Parameters<typeof screen>[0], world: World, storage: Record<string, string>) => {
    const page = await b.page(world)
    t.after(async () => {
      assert.deepEqual(page.unexpected, [])
      await page.close()
    })
    await page.open({ ...(await setUpApp({ lastChain: 'arb' })), ...storage })
    await unlock(page)
    return page
  }

  test('a schedule that is due runs once the wallet is unlocked', async (t) => {
    const page = await opened(t, standardWorld(), { ...savedRoute(), ...schedule('nightly', { kind: 'at', at: '2020-01-01T00:00:00.000Z' }) })
    await page.waitFor('document.querySelector(".statusbar .job-text").textContent === "Schedule \\"nightly\\" finished"', 30_000)
    assert.equal(await resultOf(page, 's-nightly'), 'ok')
  })

  test('a schedule that is not due yet is left alone', async (t) => {
    const page = await opened(t, standardWorld(), { ...savedRoute(), ...schedule('nightly', { kind: 'at', at: '2099-01-01T00:00:00.000Z' }) })
    await page.waitFor('document.querySelector("#sheet table.data")')
    assert.equal(await resultOf(page, 's-nightly'), undefined)
  })

  test('a scheduled run that needs an unconfirmed restricted bridge is skipped', async (t) => {
    const page = await opened(t, standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'across', rate: 0.999 }] }), { ...savedRoute({ via: 'lifi/across' }), ...schedule('nightly', { kind: 'at', at: '2020-01-01T00:00:00.000Z' }) })
    await page.waitFor('document.querySelector(".statusbar .job-text").textContent === "Schedule \\"nightly\\" skipped: needs a location confirmation"', 30_000)
    assert.equal(await resultOf(page, 's-nightly'), 'skipped: a restricted service was not confirmed when this schedule was created')
  })

  test('a fee condition waits while fees are above its limit', async (t) => {
    const page = await opened(t, standardWorld(), { ...savedRoute(), ...schedule('nightly', { kind: 'when', feesBelowUsd: 0.01, checkEveryMs: 60_000, repeat: false }) })
    await page.waitFor('document.querySelector(".statusbar .job-text").textContent === "Schedule \\"nightly\\": fees $0.05 above the limit, waiting"', 30_000)
    assert.equal(await resultOf(page, 's-nightly'), 'waiting for lower fees')
  })

  test('a schedule whose saved route is gone records why', async (t) => {
    const page = await opened(t, standardWorld(), schedule('gone', { kind: 'at', at: '2020-01-01T00:00:00.000Z' }))
    await page.waitFor('document.querySelector(".statusbar .job-text").textContent.startsWith("Schedule \\"gone\\": No saved route")', 30_000)
  })

  test('a scheduled transfer that stops records the reason (here its token approval reverted)', async (t) => {
    const page = await opened(t, standardWorld({ receipt: 'reverted' }), { ...savedRoute(), ...schedule('nightly', { kind: 'at', at: '2020-01-01T00:00:00.000Z' }) })
    await page.waitFor('document.querySelector(".statusbar .job-text").textContent.startsWith("Schedule \\"nightly\\": The transfer stopped: Token approval reverted")', 30_000)
  })

  test('a scheduled sweep runs each of its transfers', async (t) => {
    const page = await opened(t, sweepWorld(), { ...savedSweep(), ...schedule('tidy', { kind: 'at', at: '2020-01-01T00:00:00.000Z' }) })
    await page.waitFor('document.querySelector(".statusbar .job-text").textContent === "Schedule \\"tidy\\" finished"', 30_000)
  })

  test('a scheduled sweep with a transfer that stops records which one', async (t) => {
    const page = await opened(t, sweepWorld({ receipt: 'reverted' }), { ...savedSweep(), ...schedule('tidy', { kind: 'at', at: '2020-01-01T00:00:00.000Z' }) })
    await page.waitFor('document.querySelector(".statusbar .job-text").textContent.startsWith("Schedule \\"tidy\\": USDC: The transfer stopped")', 30_000)
  })

  test('a scheduled sweep with nothing to move is done with nothing sent', async (t) => {
    const page = await opened(t, sweepWorld({ balances: {} }), { ...savedSweep(), ...schedule('tidy', { kind: 'at', at: '2020-01-01T00:00:00.000Z' }) })
    await page.waitFor(`JSON.parse(localStorage.getItem("chainer/schedules/s-tidy.json")).lastResult === "nothing to send"`, 30_000)
  })

  test('the Schedules screen shows a schedule’s result as soon as it has run', async (t) => {
    const page = await screen(t, 'Schedules', standardWorld(), { ...savedRoute(), ...schedule('nightly', { kind: 'at', at: '2020-01-01T00:00:00.000Z' }) })
    await page.waitFor('document.querySelector("#sheet table.data tbody td.via-cell + td + td")?.textContent === "ok" || [...document.querySelectorAll("#sheet table.data td")].some((c) => c.textContent === "ok")', 30_000)
  })
})
