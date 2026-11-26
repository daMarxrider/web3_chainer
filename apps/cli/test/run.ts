/**
 * Runs the real chainer command against the fake network, in a data folder of its own that holds
 * a wallet made from the standard test seed. Returns what it printed, its exit code, and what it
 * did on the network.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTransaction, recoverTransactionAddress, type Hex } from 'viem'
import { addAccount } from '@chainer/core'
import { fileStore } from '../src/env.ts'
import { DIAMOND, ZERO, type LogLine, type World } from '../../../testing/fakenet/world.ts'
export { DIAMOND, ZERO }

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const PRELOAD = fileURLToPath(new URL('../../../testing/fakenet/preload.ts', import.meta.url))

export const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
/** The seed's first Ethereum account (BIP-44 test vector). */
export const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
export const PASSWORD = 'correct horse'
export const FRIEND = '0x7777777777777777777777777777777777777777'

/**
 * A data folder with the wallet "main" from the test seed, saved with 1 000 PBKDF2 rounds so each
 * unlock is quick (the rounds are read from the file, as for any keystore). Deleted after the test.
 */
export async function home(
  t: { after: (fn: () => void) => void },
  opts: { wallet?: boolean; secret?: string; more?: { name: string; secret: string; transit?: { chainKey: string; createdAt: string } }[] } = {},
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'chainer-net-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  if (opts.wallet !== false) {
    const store = fileStore(dir)
    await store.set('keystore.json', JSON.stringify({ version: 1, salt: '0x00112233445566778899aabbccddeeff', iterations: 1000, accounts: [] }))
    await addAccount(store, 'main', opts.secret ?? SEED, PASSWORD)
    for (const w of opts.more ?? []) await addAccount(store, w.name, w.secret, PASSWORD, w.transit)
  }
  return dir
}
/** Hardhat's first test key, and its address. */
export const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const KEY_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

export interface Run {
  code: number | null
  out: string
  err: string
  /** Everything the program asked the network, in order. */
  requests: string[]
  /** Requests nothing in the fake network answers; a test expects none. */
  unexpected: string[]
  /** Transactions the program broadcast, decoded, with the address that signed each. */
  broadcasts: { chain: string; chainId?: number; from: string; to?: string; value?: bigint; data?: Hex }[]
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export async function chainer(
  dir: string,
  world: World,
  args: string[],
  opts: {
    input?: string
    password?: string | null
    env?: Record<string, string>
    /** Run on a pseudo-terminal (through util-linux "script"), so the program sees a terminal. */
    tty?: boolean
    /** On a terminal: each answer is typed once its prompt has appeared in the output, in order. */
    answers?: [prompt: RegExp, keys: string][]
    /** Sends Ctrl-C (SIGINT) as soon as this holds for what the program has done and printed so far. */
    signalWhen?: (soFar: { stdout: string; log: LogLine[] }) => boolean
  } = {},
): Promise<Run> {
  const worldFile = join(dir, 'world.json')
  const logFile = join(dir, 'net.log')
  writeFileSync(worldFile, JSON.stringify(world))
  writeFileSync(logFile, '')
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, CHAINER_HOME: dir, CHAINER_FAKE_WORLD: worldFile, CHAINER_FAKE_LOG: logFile, ...opts.env }
  if (opts.password !== null) env.CHAINER_PASSWORD = opts.password ?? PASSWORD
  // For measuring which lines of the program the tests reach (see scripts/cli-coverage.py).
  if (process.env.CHAINER_COV_DIR) env.NODE_V8_COVERAGE = process.env.CHAINER_COV_DIR
  // Asynchronous, so tests can run side by side; a run over 60 s is killed and shows as a failure.
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const command = [process.execPath, '--import', PRELOAD, MAIN, ...args]
    const child = opts.tty ? spawn('script', ['-qefc', command.map(shellQuote).join(' '), '/dev/null'], { env, timeout: 60_000 }) : spawn(command[0]!, command.slice(1), { env, timeout: 60_000 })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    let watcher: NodeJS.Timeout | undefined
    if (opts.signalWhen) {
      // Condition-based, not a fixed delay: checks what happened every 50 ms.
      watcher = setInterval(() => {
        const log = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogLine)
        if (opts.signalWhen!({ stdout, log })) {
          clearInterval(watcher)
          child.kill('SIGINT')
        }
      }, 50)
    }
    child.on('close', (status) => (clearInterval(watcher), resolve({ status, stdout, stderr })))
    if (opts.tty) {
      // Keys are typed when their prompt is on screen, as a person would; checked every 20 ms.
      const pending = [...(opts.answers ?? [])]
      let seenUpTo = 0
      const typist = setInterval(() => {
        const next = pending[0]
        if (!next) return clearInterval(typist)
        const at = stdout.slice(seenUpTo).search(next[0])
        if (at < 0) return
        seenUpTo += at + 1
        pending.shift()
        child.stdin.write(next[1])
      }, 20)
      child.on('close', () => clearInterval(typist))
    } else child.stdin.end(opts.input ?? '')
  })
  const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogLine) : []
  const broadcasts = await Promise.all(
    lines.flatMap((l) => (l.kind === 'broadcast' ? [l] : [])).map(async (l) => {
      const tx = parseTransaction(l.raw as Hex)
      return { chain: l.chain, chainId: tx.chainId, from: await recoverTransactionAddress({ serializedTransaction: l.raw as never }), to: tx.to ?? undefined, value: tx.value, data: tx.data }
    }),
  )
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    requests: lines.flatMap((l) => (l.kind === 'request' ? [l.method ? `${new URL(l.url).host} ${l.method}` : l.url] : [])),
    unexpected: lines.flatMap((l) => (l.kind === 'unexpected' ? [l.url] : [])),
    broadcasts,
  }
}

/** The error the program ended with: stderr's last line, without prompts written before it on that line. */
export const lastError = (err: string) => err.trim().split('\n').at(-1)?.replace(/^.*?(?=Error:)/, '')

export { standardWorld, TOKENS } from '../../../testing/fakenet/worlds.ts'
