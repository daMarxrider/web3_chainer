// The GUI in headless Chromium against the fake network: first launch, unlocking, the main
// window, Settings, Balances, History and the address book.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { browserMissing, lazyBrowser, ME, PASSWORD, SEED, setUpApp, unlock, type Page } from './harness.ts'
import { standardWorld, TOKENS } from './worlds.ts'
import type { World } from '../../../../testing/fakenet/world.ts'

const b = lazyBrowser()
after(() => b.close())

/** A page for one test, closed when the test ends; it must make no request the fake network cannot answer. */
async function pageFor(t: { after: (fn: () => Promise<void>) => void }, world: World = standardWorld()): Promise<Page> {
  const page = await b.page(world)
  t.after(async () => {
    assert.deepEqual(page.unexpected, [], 'the page asked for something the fake network does not know')
    assert.deepEqual(page.errors, [], 'the page had uncaught errors')
    await page.close()
  })
  return page
}
const fresh = (prefs: Record<string, unknown> = {}) => ({ 'chainer/ui.json': JSON.stringify({ theme: 'modern', disclaimerAccepted: false, testMode: false, ...prefs }) })
/** The labels of the screen buttons that can be seen (a phone hides some under More). */
const visibleTabs = '[...document.querySelectorAll(".sheetlist button")].filter((b) => b.offsetParent !== null).map((b) => b.textContent)'
const buttonEnabled = (text: string) => `[...document.querySelectorAll('button')].some((b) => b.textContent.includes(${JSON.stringify(text)}) && !b.disabled)`

describe('the GUI shell', { concurrency: 6, skip: browserMissing }, () => {
  // ---- first launch ----

  test('first launch shows the looks and the disclaimer, and Continue waits for the acceptance', async (t) => {
    const page = await pageFor(t)
    await page.open(fresh())
    await page.waitFor('document.querySelector(".theme-picker")')
    assert.deepEqual([await page.evaluate('document.querySelectorAll(".theme-choice").length'), await page.evaluate(buttonEnabled('Continue'))], [5, false])
  })

  test('picking a look on first launch shows it at once', async (t) => {
    const page = await pageFor(t)
    await page.open(fresh())
    await page.waitFor('document.querySelector(".theme-picker")')
    await page.click('input[name=theme][value=night]')
    await page.waitFor('document.documentElement.dataset.theme === "night"')
  })

  test('accepting the disclaimer leads to setting up the wallet', async (t) => {
    const page = await pageFor(t)
    await page.open(fresh())
    await page.click('#accept')
    await page.click('button', 'Continue')
    await page.waitFor('document.querySelector("#w2")')
  })

  test('with the disclaimer already accepted, first launch starts at the wallet', async (t) => {
    const page = await pageFor(t)
    await page.open(fresh({ disclaimerAccepted: true }))
    await page.waitFor('document.querySelector("#w2")')
  })

  const walletStep = async (page: Page) => {
    await page.open(fresh({ disclaimerAccepted: true }))
    await page.waitFor('document.querySelector("#w2")')
  }
  const submitWallet = (page: Page) => page.evaluate('document.querySelector("input[name=password]").form.requestSubmit()')

  test('passwords that do not match are refused', async (t) => {
    const page = await pageFor(t)
    await walletStep(page)
    await page.fill('input[name=password]', 'password-one')
    await page.fill('input[name=password2]', 'password-two')
    await submitWallet(page)
    await page.waitFor('document.querySelector(".form-error").textContent === "The passwords do not match"')
  })

  test('a password under 8 characters is refused', async (t) => {
    const page = await pageFor(t)
    await walletStep(page)
    await page.fill('input[name=password]', 'short')
    await page.fill('input[name=password2]', 'short')
    await submitWallet(page)
    await page.waitFor('document.querySelector(".form-error").textContent === "Password must be at least 8 characters"')
  })

  test('a new wallet shows its 12-word seed phrase once, and opening waits for the confirmation', async (t) => {
    const page = await pageFor(t)
    await walletStep(page)
    await page.fill('input[name=password]', PASSWORD)
    await page.fill('input[name=password2]', PASSWORD)
    await submitWallet(page)
    await page.waitFor('document.querySelectorAll(".phrase li").length === 12', 30_000)
    assert.equal(await page.evaluate(buttonEnabled('Open the wallet')), false)
    await page.click('#wrote')
    await page.click('button', 'Open the wallet')
    await page.waitFor('document.querySelector("#u1")')
  })

  test('importing asks for the seed phrase, and an empty one is refused', async (t) => {
    const page = await pageFor(t)
    await walletStep(page)
    await page.click('button', 'Import a seed phrase or key')
    await page.fill('input[name=password]', PASSWORD)
    await page.fill('input[name=password2]', PASSWORD)
    await submitWallet(page)
    await page.waitFor('document.querySelector(".form-error").textContent === "Paste a seed phrase or a private key"')
  })

  test('an imported seed phrase opens as the wallet with its own address', async (t) => {
    const page = await pageFor(t)
    await walletStep(page)
    await page.click('button', 'Import a seed phrase or key')
    await page.fill('textarea[name=secret]', SEED)
    await page.fill('input[name=password]', PASSWORD)
    await page.fill('input[name=password2]', PASSWORD)
    await submitWallet(page)
    // A wallet made in the app uses the full 600 000 PBKDF2 rounds, once to save and once to unlock.
    await unlock(page, PASSWORD, 60_000)
    await page.waitFor(`document.querySelector(".address-card code")?.textContent === ${JSON.stringify(ME)}`, 30_000)
  })

  test('something that is neither a seed phrase nor a key is refused on import', async (t) => {
    const page = await pageFor(t)
    await walletStep(page)
    await page.click('button', 'Import a seed phrase or key')
    await page.fill('textarea[name=secret]', 'not a seed phrase')
    await page.fill('input[name=password]', PASSWORD)
    await page.fill('input[name=password2]', PASSWORD)
    await submitWallet(page)
    await page.waitFor('document.querySelector(".form-error").textContent === "Not a valid private key or BIP-39 seed phrase"', 30_000)
  })

  test('switching back from import hides the seed field again', async (t) => {
    const page = await pageFor(t)
    await walletStep(page)
    await page.click('button', 'Import a seed phrase or key')
    await page.click('button', 'Make a new wallet instead')
    assert.equal(await page.evaluate('document.querySelector("textarea[name=secret]").closest("label").hidden'), true)
  })

  // ---- unlocking ----

  test('a wrong password is refused and the unlock button works again', async (t) => {
    const page = await pageFor(t)
    await page.open(await setUpApp())
    await page.waitFor('document.querySelector("input[type=password]")')
    await page.fill('input[type=password]', 'wrong password')
    await page.evaluate('document.querySelector("input[type=password]").form.requestSubmit()')
    await page.waitFor('document.querySelector(".form-error").textContent === "Wrong password"')
    assert.equal(await page.evaluate(buttonEnabled('Unlock')), true)
  })

  test('with one wallet there is no wallet choice; the main window opens after unlocking', async (t) => {
    const page = await pageFor(t)
    await page.open(await setUpApp())
    await page.waitFor('document.querySelector("input[type=password]")')
    assert.equal(await page.has('select[name=wallet]:not([hidden])'), false)
    await unlock(page)
  })

  // ---- the main window ----

  const mainWindow = async (t: Parameters<typeof pageFor>[0], world?: World, prefs: Record<string, unknown> = {}) => {
    const page = await pageFor(t, world)
    await page.open(await setUpApp({ lastChain: 'arb', ...prefs }))
    await unlock(page)
    return page
  }

  test('the main window lists the ten screens and Lock, with Balances open', async (t) => {
    const page = await mainWindow(t)
    const labels = await page.evaluate<string[]>(visibleTabs)
    assert.deepEqual([labels, await page.evaluate('document.querySelector("#sheet").dataset.screen')], [['Balances', 'Transfer', 'Bridge wallet', 'Pipelines', 'Saved routes', 'Schedules', 'Address book', 'History', 'Settings', 'About', 'Lock'], 'balances'])
  })

  test('About shows the version, the developer and the disclaimer', async (t) => {
    const page = await mainWindow(t)
    await page.click('.sheetlist button', 'About')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "about"')
    const facts = await page.evaluate<string[]>('[...document.querySelectorAll("#sheet .summary dd")].map((d) => d.textContent)')
    const { version } = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string }
    assert.deepEqual(facts.slice(0, 2), [version, 'DaMarxrider'])
    assert.equal(await page.evaluate(buttonEnabled('Check for updates')), true)
    assert.equal(await page.evaluate('document.querySelector("#sheet").textContent.includes("not liable")'), true)
  })

  // ---- the phone shell ----

  const phoneWindow = async (t: Parameters<typeof pageFor>[0]) => {
    const page = await pageFor(t)
    await page.phone()
    await page.open(await setUpApp({ lastChain: 'arb' }))
    await unlock(page)
    return page
  }
  const moreItems = '[...document.querySelectorAll(".more-sheet .more-item")].map((b) => b.textContent)'

  test('on a phone the tab strip holds Balances, Transfer, History and More, and the network switch sits in the title bar', async (t) => {
    const page = await phoneWindow(t)
    assert.deepEqual(await page.evaluate(visibleTabs), ['Balances', 'Transfer', 'History', 'More'])
    assert.equal(await page.evaluate('document.querySelector(".titlebar .mode-top").offsetParent !== null && document.querySelector(".statusbar .mode-strip").offsetParent === null'), true)
  })

  test('on a phone More lists the other screens and Lock, opens the one picked and marks More as current', async (t) => {
    const page = await phoneWindow(t)
    await page.click('.more-tab')
    await page.waitFor('document.querySelector(".more-sheet[open]")')
    assert.deepEqual(await page.evaluate(moreItems), ['Bridge wallet', 'Pipelines', 'Saved routes', 'Schedules', 'Address book', 'Settings', 'About', 'Lock'])
    await page.click('.more-item', 'Settings')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "settings" && !document.querySelector(".more-sheet") && document.querySelector(".more-tab").hasAttribute("aria-current")')
  })

  test('on a phone Lock under More locks the wallet', async (t) => {
    const page = await phoneWindow(t)
    await page.click('.more-tab')
    await page.click('.more-item', 'Lock')
    await page.waitFor('document.querySelector("input[type=password]") && !document.querySelector(".window.main")')
  })

  test('the back button closes an open sheet first, then returns to the previous screen', async (t) => {
    const page = await phoneWindow(t)
    await page.click('.sheetlist button', 'History')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "history"')
    await page.click('.more-tab')
    await page.waitFor('document.querySelector(".more-sheet[open]")')
    await page.evaluate('history.back()')
    await page.waitFor('!document.querySelector(".more-sheet")')
    assert.equal(await page.evaluate('document.querySelector("#sheet").dataset.screen'), 'history')
    await page.evaluate('history.back()')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "balances"')
  })

  test('a screen picked under More is one back step away from the screen before it', async (t) => {
    const page = await phoneWindow(t)
    await page.click('.sheetlist button', 'History')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "history"')
    const before = await page.evaluate<number>('history.length')
    await page.click('.more-tab')
    await page.click('.more-item', 'Settings')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "settings"')
    assert.equal(await page.evaluate('history.length'), before + 1, 'one step for Settings; the closed sheet left none')
    await page.evaluate('history.back()')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "history" && !history.state.dialog')
    await page.evaluate('history.back()')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "balances"')
  })

  test('a sheet closed without the back button leaves no step behind', async (t) => {
    const page = await phoneWindow(t)
    await page.click('.sheetlist button', 'History')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "history"')
    await page.click('.more-tab')
    await page.waitFor('document.querySelector(".more-sheet[open]")')
    await page.evaluate('document.querySelector(".more-sheet").close()')
    await page.waitFor('!document.querySelector(".more-sheet") && !history.state?.dialog')
    await page.evaluate('history.back()')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "balances"')
  })

  test('on a phone a table row reads as heading and value lines', async (t) => {
    const page = await phoneWindow(t)
    await page.waitFor('document.querySelector("#sheet table.data tbody td")')
    const cells = await page.evaluate<string[]>('[...document.querySelector("#sheet table.data tbody tr").cells].map((c) => (c.dataset.label ?? "-") + "=" + getComputedStyle(c, "::before").content)')
    assert.deepEqual(cells.slice(1), ['Balance="Balance"', 'Value="Value"', 'Contract="Contract"'])
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#sheet table.data thead")).position'), 'absolute')
  })

  test('opening a screen marks it as the current one', async (t) => {
    const page = await mainWindow(t)
    await page.click('.sheetlist button', 'Settings')
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "settings" && document.querySelector(".sheetlist [aria-current]").textContent === "Settings"')
  })

  test('a screen opened while another is still loading stays open', async (t) => {
    // Balances is still reading its chain list when Settings is opened; Balances must not come back.
    const page = await mainWindow(t)
    await page.click('.sheetlist button', 'Settings')
    await page.waitFor('document.querySelector("#s-slippage")')
    // Wait until Balances has had its balances answered, i.e. its late render has happened.
    await page.waitForLog((log) => log.some((l) => l.kind === 'request' && l.method === 'eth_call'))
    await page.waitFor('document.querySelector("#sheet").dataset.screen === "settings" && document.querySelector("#s-slippage")')
  })

  test('Lock returns to the unlock window', async (t) => {
    const page = await mainWindow(t)
    await page.click('.sheetlist button', 'Lock')
    await page.waitFor('document.querySelector("#u1")')
  })

  test('the status strip names the wallet and says no job is running', async (t) => {
    const page = await mainWindow(t)
    assert.deepEqual([await page.text('.statusbar .grow'), await page.text('.statusbar .job-text')], ['Wallet main', 'No job running'])
  })

  test('the network button switches to test networks and says so in the title and the strip', async (t) => {
    const page = await mainWindow(t)
    await page.click('.statusbar .mode')
    await page.waitFor('document.querySelector(".title-meta")?.textContent === "Test networks" && document.querySelector(".statusbar .mode").textContent === "Test networks"')
  })

  test('a screen that cannot be shown shows why, inside the window', async (t) => {
    const page = await pageFor(t)
    await page.open({ ...(await setUpApp({ lastChain: 'arb' })), 'chainer/pipelines/broken.json': '{"id":' })
    await unlock(page)
    await page.click('.sheetlist button', 'History')
    await page.waitFor('document.querySelector("#sheet .form-error")?.textContent.includes("JSON")')
    page.errors.length = 0
  })

  // ---- balances ----

  test('Balances lists what the wallet holds with value, and the total', async (t) => {
    const page = await mainWindow(t)
    await page.waitFor('document.querySelectorAll("table.data tbody tr").length === 2')
    assert.deepEqual([await page.text('table.data tbody tr:first-child th'), await page.text('table.data tfoot td.num')], ['USDC', '$1,030.00'])
  })

  test('Balances shows the wallet’s address and copies it', async (t) => {
    const page = await mainWindow(t)
    await page.waitFor('document.querySelector(".address-card button")')
    await page.click('.address-card button')
    await page.waitFor('document.querySelector(".address-card button").textContent === "Copied"')
    assert.equal(await page.evaluate('navigator.clipboard.readText()'), ME)
  })

  test('a chain where the wallet holds nothing says so', async (t) => {
    const page = await mainWindow(t, standardWorld({ balances: {} }))
    await page.waitFor('document.querySelector(".table-wrap .empty")?.textContent === "No tokens found on Arbitrum."')
  })

  test('choosing another chain reads its balances and is remembered', async (t) => {
    const page = await mainWindow(t)
    await page.waitFor('document.querySelectorAll("table.data tbody tr").length === 2')
    await page.fill('select[name=chain]', 'bas')
    await page.waitFor('document.querySelector(".hint[role=status]").textContent.endsWith("on Base")')
    assert.equal(JSON.parse(await page.evaluate<string>('localStorage.getItem("chainer/ui.json")')).lastChain, 'bas')
  })

  test('a token flagged as a scam is tagged and left out of the total', async (t) => {
    const flagged = { chain: 'arb', symbol: 'FREE', address: '0x9999999999999999999999999999999999999999', decimals: 18, price: 100, status: 'flagged' as const }
    const page = await mainWindow(t, standardWorld({ tokens: [...Object.values(TOKENS), flagged], balances: { [ME]: { [`arb:${flagged.address}`]: '1000000000000000000' } } }))
    await page.waitFor('document.querySelector("table.data .tag")?.textContent === "flagged"')
    assert.equal(await page.text('table.data tfoot td.num'), '$0.00')
  })

  test('balances that cannot be read say why', async (t) => {
    const page = await mainWindow(t, standardWorld({ tokensError: { status: 500, message: 'down' } }))
    await page.waitFor('document.querySelector(".table-wrap .form-error")?.textContent === "Could not read balances: li.quest responded 500: down"')
  })

  test('Refresh reads the balances again', async (t) => {
    const page = await mainWindow(t)
    await page.waitFor('document.querySelectorAll("table.data tbody tr").length === 2')
    page.setWorld(standardWorld({ balances: {} }))
    await page.click('button', 'Refresh')
    await page.waitFor('document.querySelector(".table-wrap .empty")?.textContent === "No tokens found on Arbitrum."')
  })

  // ---- settings ----

  const settings = async (t: Parameters<typeof pageFor>[0]) => {
    const page = await mainWindow(t)
    await page.click('.sheetlist button', 'Settings')
    await page.waitFor('document.querySelector("#s-slippage")')
    return page
  }
  const save = (page: Page) => page.evaluate('document.querySelector("#s-slippage").form.requestSubmit()')
  const settingsError = (page: Page, text: string) => page.waitFor(`document.querySelector("#sheet .form-error").textContent === ${JSON.stringify(text)}`)

  test('a look picked in Settings is used and confirmed', async (t) => {
    const page = await settings(t)
    await page.click('input[name=theme][value=retro]')
    await page.waitFor('document.documentElement.dataset.theme === "retro" && document.querySelector("#sheet .hint[role=status]").textContent === "Retro theme on"')
  })

  test('test networks can be switched on in Settings', async (t) => {
    const page = await settings(t)
    await page.click('input[name=test]')
    await page.waitFor('JSON.parse(localStorage.getItem("chainer/ui.json")).testMode === true')
  })

  test('saved defaults are stored', async (t) => {
    const page = await settings(t)
    await page.fill('#s-slippage', '1')
    await page.fill('#s-hops', '2')
    await page.fill('#s-limit', '250')
    await page.fill('#s-avoid', 'USDT, SHIB')
    await page.fill('#s-prefer', 'fastest')
    await save(page)
    await page.waitFor('document.querySelector("#sheet .hint[role=status]").textContent === "Saved"')
    const s = JSON.parse(await page.evaluate<string>('localStorage.getItem("chainer/settings.json")'))
    assert.deepEqual([s.slippage, s.maxHops, s.maxUsdPerTransfer, s.avoidTokens, s.prefer], [0.01, 2, 250, ['USDT', 'SHIB'], 'fastest'])
  })

  test('an empty limit means no limit', async (t) => {
    const page = await settings(t)
    await page.fill('#s-limit', '')
    await save(page)
    await page.waitFor('document.querySelector("#sheet .hint[role=status]").textContent === "Saved"')
    assert.equal(JSON.parse(await page.evaluate<string>('localStorage.getItem("chainer/settings.json")')).maxUsdPerTransfer, null)
  })

  test('the gas top-up can be set to a fixed value', async (t) => {
    const page = await settings(t)
    await page.fill('#s-gasmode', 'fixed')
    await page.fill('#s-gasfixed', '3')
    await save(page)
    await page.waitFor('document.querySelector("#sheet .hint[role=status]").textContent === "Saved"')
    assert.deepEqual(JSON.parse(await page.evaluate<string>('localStorage.getItem("chainer/settings.json")')).gasTopUp, { mode: 'fixed', multiplier: 2, fixedUsd: 3 })
  })

  test('a slippage of 50 percent is refused', async (t) => {
    const page = await settings(t)
    await page.fill('#s-slippage', '50')
    await save(page)
    await settingsError(page, 'Slippage must be between 0 and 50 percent')
  })

  test('a hop limit of 6 is refused by the field itself, and nothing is saved', async (t) => {
    const page = await settings(t)
    await page.fill('#s-hops', '6')
    await save(page)
    assert.deepEqual([await page.evaluate('document.querySelector("#s-hops").validity.rangeOverflow'), await page.evaluate('localStorage.getItem("chainer/settings.json")')], [true, null])
  })

  test('a limit of zero is refused', async (t) => {
    const page = await settings(t)
    await page.fill('#s-limit', '0')
    await save(page)
    await settingsError(page, 'The limit must be a positive amount in dollars, or empty for none')
  })

  test('a gas multiplier under 0.5 is refused', async (t) => {
    const page = await settings(t)
    await page.fill('#s-gasmult', '0.4')
    await save(page)
    await settingsError(page, 'The gas multiplier must be between 0.5 and 20')
  })

  test('a fixed gas value over $50 is refused', async (t) => {
    const page = await settings(t)
    await page.fill('#s-gasfixed', '51')
    await save(page)
    await settingsError(page, 'The fixed gas value must be between $0.10 and $50')
  })

  // ---- history ----

  test('History without runs says so for the network in use', async (t) => {
    const page = await mainWindow(t)
    await page.click('.sheetlist button', 'History')
    await page.waitFor('document.querySelector("#sheet .empty")?.textContent === "No transfers yet on real networks."')
  })

  // ---- address book ----

  const book = async (t: Parameters<typeof pageFor>[0]) => {
    const page = await mainWindow(t)
    await page.click('.sheetlist button', 'Address book')
    await page.waitFor('document.querySelector("#ab-label")')
    return page
  }
  const addEntry = async (page: Page, label: string, chain: string, address: string) => {
    await page.fill('#ab-label', label)
    await page.fill('#ab-chain', chain)
    await page.fill('#ab-address', address)
    await page.evaluate('document.querySelector("#ab-label").form.requestSubmit()')
  }

  test('an empty address book explains what it is for', async (t) => {
    const page = await book(t)
    await page.waitFor('document.querySelector("#sheet .empty")?.textContent.startsWith("The address book is empty.")')
  })

  test('a saved address is listed with its chain', async (t) => {
    const page = await book(t)
    await addEntry(page, 'friend', 'bas', '0x7777777777777777777777777777777777777777')
    await page.waitFor('document.querySelector("#sheet table.data tbody th")?.textContent === "friend"')
    assert.equal(await page.text('#sheet table.data tbody td'), 'Base')
  })

  test('an address that is not valid on the chain is not saved', async (t) => {
    const page = await book(t)
    await addEntry(page, 'friend', 'bas', 'nope')
    await page.waitFor('document.querySelector("#sheet .form-error").textContent === "\\"nope\\" is not a valid address on bas"')
  })

  test('a removed address is gone from the list', async (t) => {
    const page = await book(t)
    await addEntry(page, 'friend', 'bas', '0x7777777777777777777777777777777777777777')
    await page.waitFor('document.querySelector("#sheet table.data")')
    await page.click('#sheet table.data button', 'Remove')
    await page.waitFor('document.querySelector("#sheet .empty")?.textContent.startsWith("The address book is empty.")')
  })
})
