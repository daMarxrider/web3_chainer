/**
 * Runs the GUI in headless Chromium for tests: Vite serves the app with its own config, the
 * Chrome DevTools Protocol drives the page (over Node's built-in WebSocket), and every request
 * that does not go to the app itself is answered by the shared fake network (testing/fakenet).
 * Each test gets its own browser context, so storage never leaks between tests.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { addAccount, type Store } from '@chainer/core'
import { fakeNetwork } from '../../../../testing/fakenet/answer.ts'
import type { LogLine, World } from '../../../../testing/fakenet/world.ts'

const GUI_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The Chromium (or Chrome) binary; CHROMIUM overrides it, e.g. google-chrome on CI runners. */
const CHROMIUM = process.env.CHROMIUM ?? 'chromium'
/** Why the browser tests cannot run here, or undefined when they can. */
export const browserMissing = spawnSync(CHROMIUM, ['--version'], { encoding: 'utf8' }).status === 0 ? undefined : `${CHROMIUM} is not installed; the GUI browser tests need it (set CHROMIUM to another binary)`

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** A browser and the app's dev server, shared by the tests of one file. */
export class Browser {
  private ws!: WebSocket
  private chrome!: ChildProcess
  private profile!: string
  private vite!: ViteDevServer
  origin!: string
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Set<(m: { method: string; params: Record<string, unknown>; sessionId?: string }) => void>()

  static async start(): Promise<Browser> {
    const b = new Browser()
    b.vite = await createServer({ root: GUI_ROOT, configFile: join(GUI_ROOT, 'vite.config.ts'), logLevel: 'silent', server: { port: 0, strictPort: false, host: '127.0.0.1' } })
    await b.vite.listen()
    const address = b.vite.httpServer!.address() as { port: number }
    b.origin = `http://127.0.0.1:${address.port}`
    b.profile = mkdtempSync(join(tmpdir(), 'chainer-gui-'))
    b.chrome = spawn(CHROMIUM, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${b.profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let err = ''
      b.chrome.stderr!.on('data', (d: Buffer) => {
        err += d
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err)
        if (m) resolve(m[1]!)
      })
      b.chrome.on('exit', () => reject(new Error(`Chromium exited: ${err.slice(0, 500)}`)))
    })
    b.ws = new WebSocket(wsUrl)
    await new Promise((r) => b.ws.addEventListener('open', r, { once: true }))
    // If a file's "after" hook never runs (all its tests filtered out), nothing here may keep the
    // test process alive, and Chromium must not outlive it.
    b.chrome.unref()
    ;(b.chrome.stderr as unknown as { unref(): void }).unref()
    b.vite.httpServer?.unref()
    process.once('exit', () => {
      b.chrome.kill()
      rmSync(b.profile, { recursive: true, force: true })
    })
    b.ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id && b.pending.has(m.id)) {
        const p = b.pending.get(m.id)!
        b.pending.delete(m.id)
        if (m.error) p.reject(new Error(`${m.error.message}`))
        else p.resolve(m.result)
      } else if (m.method) for (const l of b.listeners) l(m)
    })
    return b
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }))
  }
  on(l: (m: { method: string; params: Record<string, unknown>; sessionId?: string }) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** A new page in its own browser context, with the fake network for `world`. */
  async page(world: World): Promise<Page> {
    const { browserContextId } = await this.send<{ browserContextId: string }>('Target.createBrowserContext')
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this, sessionId, browserContextId, world)
    await page.init()
    return page
  }

  async close(): Promise<void> {
    this.ws.close()
    this.chrome.kill()
    await this.vite.close()
    rmSync(this.profile, { recursive: true, force: true })
  }
}

/**
 * The browser for one test file, started when a test first asks for a page. A file whose tests are
 * all filtered out (--test-name-pattern) then starts nothing, so it cannot keep the run alive.
 */
export function lazyBrowser() {
  let started: Promise<Browser> | undefined
  return {
    page: async (world: World) => (await (started ??= Browser.start())).page(world),
    close: async () => {
      if (started) await (await started).close()
    },
  }
}

const CORS = [
  { name: 'access-control-allow-origin', value: '*' },
  { name: 'access-control-allow-headers', value: '*' },
  { name: 'access-control-allow-methods', value: 'GET, POST, OPTIONS' },
]

export class Page {
  /** The fake network's log: every request the page made, and any it could not answer. */
  readonly log: LogLine[] = []
  /** Uncaught exceptions and console errors in the page. */
  readonly errors: string[] = []
  private net: ReturnType<typeof fakeNetwork>
  private off?: () => void

  private b: Browser
  readonly sessionId: string
  private contextId: string
  world: World

  constructor(b: Browser, sessionId: string, contextId: string, world: World) {
    this.b = b
    this.sessionId = sessionId
    this.contextId = contextId
    this.world = world
    this.net = fakeNetwork(world, (l) => this.log.push(l))
  }

  /** Changes what the fake network answers from now on. */
  setWorld(world: World): void {
    this.world = world
    this.net = fakeNetwork(world, (l) => this.log.push(l))
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) {
    return this.b.send<T>(method, params, this.sessionId)
  }

  async init(): Promise<void> {
    this.off = this.b.on((m) => {
      if (m.sessionId !== this.sessionId) return
      if (m.method === 'Fetch.requestPaused') void this.answer(m.params as { requestId: string; request: { url: string; method: string; postData?: string } })
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(JSON.stringify((m.params as { exceptionDetails: unknown }).exceptionDetails))
      if (m.method === 'Runtime.consoleAPICalled' && (m.params as { type: string }).type === 'error') this.errors.push(JSON.stringify((m.params as { args: unknown }).args))
    })
    await this.send('Runtime.enable')
    await this.send('Page.enable')
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    // Which code ran, for scripts/gui-coverage.py (only when asked for).
    if (process.env.GUI_COV_FILE) {
      await this.send('Profiler.enable')
      await this.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
    }
    await this.b.send('Browser.grantPermissions', { origin: this.b.origin, browserContextId: this.contextId, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  }

  /** Shows the page as a phone would: a 393x852 touch screen. Call before `open`. */
  async phone(): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true })
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  }

  private async answer(p: { requestId: string; request: { url: string; method: string; postData?: string } }): Promise<void> {
    const { url, method, postData } = p.request
    if (url.startsWith(this.b.origin) || url.startsWith('data:')) return void (await this.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined))
    if (method === 'OPTIONS') return void (await this.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: CORS }))
    try {
      const res = await this.net(url, { method, body: postData })
      const body = Buffer.from(await res.arrayBuffer()).toString('base64')
      await this.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: res.status, responseHeaders: [...CORS, { name: 'content-type', value: 'application/json' }], body })
    } catch {
      await this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' })
    }
  }

  /** Requests nothing in the fake network answers; a test expects none. */
  get unexpected(): string[] {
    return this.log.flatMap((l) => (l.kind === 'unexpected' ? [l.url] : []))
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value as T
  }

  /** Waits until `expression` is truthy in the page, checking every 50 ms, for at most `ms`. */
  async waitFor(expression: string, ms = 15_000): Promise<void> {
    const until = Date.now() + ms
    for (;;) {
      if (await this.evaluate<boolean>(`!!(${expression})`).catch(() => false)) return
      if (Date.now() > until) throw new Error(`Timed out waiting for: ${expression}\nPage text: ${(await this.text('body').catch(() => '')).slice(0, 1500)}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /** Waits until the fake network's log satisfies `check`, checking every 50 ms, for at most `ms`. */
  async waitForLog(check: (log: LogLine[]) => boolean, ms = 15_000): Promise<void> {
    const until = Date.now() + ms
    while (!check(this.log)) {
      if (Date.now() > until) throw new Error('Timed out waiting for the network log')
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /** Opens the app; `storage` is written to localStorage before it starts. */
  async open(storage: Record<string, string> = {}): Promise<void> {
    await this.send('Page.navigate', { url: `${this.b.origin}/robots.txt` })
    await this.waitFor('document.readyState === "complete"')
    await this.evaluate(`localStorage.clear(); ${Object.entries(storage).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')}`)
    await this.send('Page.navigate', { url: `${this.b.origin}/` })
    // Either the app's first window, or the text it shows when it cannot start.
    await this.waitFor('document.querySelector("#app") && (document.querySelector("#app").childElementCount > 0 || document.querySelector("#app").textContent.length > 0)')
  }

  text(selector: string): Promise<string> {
    return this.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`)
  }
  async has(selector: string): Promise<boolean> {
    return this.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)
  }
  /** Clicks the first element matching `selector` whose text includes `text` (any element when no text). */
  async click(selector: string, text?: string): Promise<void> {
    const found = await this.evaluate<boolean>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text === undefined ? 'true' : `e.textContent.includes(${JSON.stringify(text)})`})
      if (!el) return false
      el.click()
      return true
    })()`)
    if (!found) throw new Error(`Nothing to click: ${selector}${text ? ` with "${text}"` : ''}\nPage text: ${(await this.text('body')).slice(0, 1500)}`)
  }
  /** Sets a field's value as typing would, firing input and change; waits for the field to be there first. */
  async fill(selector: string, value: string): Promise<void> {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`)
    const found = await this.evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.focus()
      el.value = ${JSON.stringify(value)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    if (!found) throw new Error(`No field ${selector}`)
  }
  /** Presses a key in the focused element. */
  async key(selector: string, key: string): Promise<void> {
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`)
  }

  async close(): Promise<void> {
    if (process.env.GUI_COV_FILE) {
      const { result } = await this.send<{ result: { url: string; functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[] }[] }>('Profiler.takePreciseCoverage')
      for (const script of result.filter((r) => r.url.startsWith(`${this.b.origin}/src/`))) {
        appendFileSync(process.env.GUI_COV_FILE, `${JSON.stringify({ path: script.url.slice(this.b.origin.length).split('?')[0], origin: this.b.origin, ranges: script.functions.flatMap((f) => f.ranges) })}\n`)
      }
    }
    this.off?.()
    await this.b.send('Target.disposeBrowserContext', { browserContextId: this.contextId }).catch(() => undefined)
  }
}

// ---- a wallet for the page ----

export const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
export const PASSWORD = 'correct horse'
export const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

/** localStorage for an app that is set up: a wallet "main" from the test seed (1 000 PBKDF2 rounds, so unlocking is quick) and the given preferences. */
export async function setUpApp(prefs: Record<string, unknown> = {}, settings?: Record<string, unknown>): Promise<Record<string, string>> {
  const data = new Map<string, string>([['keystore.json', JSON.stringify({ version: 1, salt: '0x00112233445566778899aabbccddeeff', iterations: 1000, accounts: [] })]])
  const store: Store = { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), keys: async () => [...data.keys()] }
  await addAccount(store, 'main', SEED, PASSWORD)
  const storage: Record<string, string> = {
    'chainer/keystore.json': data.get('keystore.json')!,
    'chainer/ui.json': JSON.stringify({ theme: 'modern', disclaimerAccepted: true, testMode: false, ...prefs }),
  }
  if (settings) storage['chainer/settings.json'] = JSON.stringify(settings)
  return storage
}

/** Types the password into the unlock window and waits for the main window. */
export async function unlock(page: Page, password = PASSWORD, ms = 15_000): Promise<void> {
  await page.waitFor('document.querySelector("input[type=password]")', ms)
  await page.fill('input[type=password]', password)
  await page.evaluate('document.querySelector("input[type=password]").form.requestSubmit()')
  await page.waitFor('document.querySelector(".window.main")', ms)
}
