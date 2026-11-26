// End-to-end tests of the chainer command for what works offline: each test runs the real program in
// a subprocess with its own empty data folder (CHAINER_HOME), removed afterwards. No network is used.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
/** First Ethereum account of the seed above (BIP-44 test vector). */
const SEED_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

/** A fresh data folder for one test, deleted when it ends. */
function home(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'chainer-cli-e2e-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Runs `chainer <args>` with the given data folder; a run that takes over 20 s is killed and fails. */
function chainer(dataDir: string, args: string[], opts: { input?: string; password?: string } = {}) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dataDir, CHAINER_HOME: dataDir }
  if (process.env.CHAINER_COV_DIR) env.NODE_V8_COVERAGE = process.env.CHAINER_COV_DIR
  if (opts.password !== undefined) env.CHAINER_PASSWORD = opts.password
  const r = spawnSync(process.execPath, [MAIN, ...args], { env, input: opts.input ?? '', encoding: 'utf8', timeout: 20_000 })
  if (r.error) throw r.error
  return { code: r.status, out: r.stdout, err: r.stderr }
}
/** The error the program ended with: stderr's last line, without the prompts written before it on that line. */
const lastError = (err: string) => err.trim().split('\n').at(-1)?.replace(/^.*?(?=Error:)/, '')
const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))

describe('the chainer command', { concurrency: true }, () => {
  // ---- help and mistakes ----

  test('without a command it prints the help and succeeds', (t) => {
    const r = chainer(home(t), [])
    assert.deepEqual([r.code, r.out.includes('chainer wallet'), r.err], [0, true, ''])
  })

  test('--help prints the same help', (t) => {
    const dir = home(t)
    assert.equal(chainer(dir, ['--help']).out, chainer(dir, []).out)
  })

  test('an unknown command fails with a pointer to the help', (t) => {
    const r = chainer(home(t), ['frobnicate'])
    assert.deepEqual([r.code, r.err.trim()], [1, 'Error: Unknown command "frobnicate". Run "chainer --help".'])
  })

  // ---- wallets ----

  test('listing wallets before there are any says how to make one', (t) => {
    assert.equal(chainer(home(t), ['wallet', 'list']).out.trim(), 'No wallets yet. Create one with "chainer wallet init".')
  })

  test('an unknown wallet subcommand fails with the usage', (t) => {
    const r = chainer(home(t), ['wallet', 'burn'])
    assert.deepEqual([r.code, r.err.trim()], [1, 'Error: Use: chainer wallet init | import | list | refresh'])
  })

  test('wallet init makes a wallet called "main" and shows a 12-word seed phrase once', (t) => {
    const r = chainer(home(t), ['wallet', 'init'], { password: 'correct horse' })
    const phrase = r.out.split('\n').find((l) => /^ {2}([a-z]+ ){11}[a-z]+$/.test(l))
    assert.deepEqual([r.code, /Wallet "main" saved\. EVM address: 0x[0-9a-fA-F]{40}/.test(r.out), phrase !== undefined], [0, true, true])
  })

  test('the wallet file made by wallet init is readable by its owner only', (t) => {
    const dir = home(t)
    chainer(dir, ['wallet', 'init'], { password: 'correct horse' })
    assert.equal(statSync(join(dir, 'keystore.json')).mode & 0o777, 0o600)
  })

  test('the wallet file does not contain the seed phrase that was shown', (t) => {
    const dir = home(t)
    const r = chainer(dir, ['wallet', 'init'], { password: 'correct horse' })
    const phrase = r.out.split('\n').find((l) => /^ {2}([a-z]+ ){11}[a-z]+$/.test(l))!.trim()
    assert.equal(readFileSync(join(dir, 'keystore.json'), 'utf8').includes(phrase.split(' ')[0]! + ' ' + phrase.split(' ')[1]!), false)
  })

  test('a second wallet init gets the name "wallet2"', (t) => {
    const dir = home(t)
    chainer(dir, ['wallet', 'init'], { password: 'correct horse' })
    assert.match(chainer(dir, ['wallet', 'init'], { password: 'correct horse' }).out, /^Wallet "wallet2" saved\./)
  })

  test('wallet init with a password under 8 characters fails and writes no wallet file', (t) => {
    const dir = home(t)
    const r = chainer(dir, ['wallet', 'init'], { password: 'short' })
    assert.deepEqual([r.code, r.err.trim(), existsSync(join(dir, 'keystore.json'))], [1, 'Error: Password must be at least 8 characters', false])
  })

  test('wallet import reads the seed phrase from piped input and keeps its address', (t) => {
    const r = chainer(home(t), ['wallet', 'import'], { input: `${SEED}\n`, password: 'correct horse' })
    assert.match(r.out, new RegExp(`Wallet "main" saved\\. EVM address: ${SEED_EVM}`))
  })

  test('wallet import never prints the imported seed phrase', (t) => {
    const r = chainer(home(t), ['wallet', 'import'], { input: `${SEED}\n`, password: 'correct horse' })
    assert.equal(r.out.includes('abandon'), false)
  })

  test('wallet import with --name uses that name', (t) => {
    const r = chainer(home(t), ['wallet', 'import', '--name', 'cold'], { input: `${SEED}\n`, password: 'correct horse' })
    assert.match(r.out, /^Wallet "cold" saved\./)
  })

  test('wallet import of something that is not a seed phrase or key fails', (t) => {
    const r = chainer(home(t), ['wallet', 'import'], { input: 'not a seed phrase\n', password: 'correct horse' })
    assert.deepEqual([r.code, lastError(r.err)], [1, 'Error: Not a valid private key or BIP-39 seed phrase'])
  })

  test('typing the password twice by hand, differently, is refused', (t) => {
    const dir = home(t)
    const r = chainer(dir, ['wallet', 'import'], { input: `${SEED}\npassword-one\npassword-two\n` })
    assert.deepEqual([r.code, lastError(r.err), existsSync(join(dir, 'keystore.json'))], [1, 'Error: The passwords do not match', false])
  })

  test('wallet list --json shows each wallet’s name, type and addresses', (t) => {
    const dir = home(t)
    chainer(dir, ['wallet', 'import'], { input: `${SEED}\n`, password: 'correct horse' })
    const [w] = JSON.parse(chainer(dir, ['wallet', 'list', '--json']).out)
    assert.deepEqual([w.name, w.type, w.addresses.evm], ['main', 'seed', SEED_EVM])
  })

  test('wallet list --json never includes the encrypted data', (t) => {
    const dir = home(t)
    chainer(dir, ['wallet', 'import'], { input: `${SEED}\n`, password: 'correct horse' })
    const [w] = JSON.parse(chainer(dir, ['wallet', 'list', '--json']).out)
    assert.deepEqual(Object.keys(w).sort(), ['addresses', 'name', 'type'])
  })

  // ---- settings ----

  test('config show prints the defaults when nothing was set', (t) => {
    const s = JSON.parse(chainer(home(t), ['config', 'show']).out)
    assert.deepEqual([s.prefer, s.slippage, s.maxHops], ['cheapest', 0.005, 3])
  })

  test('a slippage set by config is saved', (t) => {
    const dir = home(t)
    chainer(dir, ['config', 'set', 'slippage', '0.01'])
    assert.equal(settingsOf(dir).slippage, 0.01)
  })

  test('a slippage of 0.5 or more is refused', (t) => {
    const r = chainer(home(t), ['config', 'set', 'slippage', '0.5'])
    assert.deepEqual([r.code, r.err.trim()], [1, 'Error: slippage is a fraction between 0 and 0.5, e.g. 0.005 for 0.5 %'])
  })

  test('a slippage of zero is refused', (t) => {
    assert.equal(chainer(home(t), ['config', 'set', 'slippage', '0']).code, 1)
  })

  test('a slippage that is not a number is refused', (t) => {
    assert.equal(chainer(home(t), ['config', 'set', 'slippage', 'half']).code, 1)
  })

  test('a refused setting leaves the settings file unwritten', (t) => {
    const dir = home(t)
    chainer(dir, ['config', 'set', 'slippage', '0.9'])
    assert.equal(existsSync(join(dir, 'settings.json')), false)
  })

  test('the hop limit accepts 5', (t) => {
    const dir = home(t)
    chainer(dir, ['config', 'set', 'maxHops', '5'])
    assert.equal(settingsOf(dir).maxHops, 5)
  })

  test('a hop limit of 6 is refused', (t) => {
    assert.match(chainer(home(t), ['config', 'set', 'maxHops', '6']).err, /maxHops must be a whole number from 1 to 5/)
  })

  test('a hop limit of 0 is refused', (t) => {
    assert.equal(chainer(home(t), ['config', 'set', 'maxHops', '0']).code, 1)
  })

  test('a hop limit that is not whole is refused', (t) => {
    assert.equal(chainer(home(t), ['config', 'set', 'maxHops', '2.5']).code, 1)
  })

  test('the per-transfer limit can be switched off', (t) => {
    const dir = home(t)
    chainer(dir, ['config', 'set', 'maxUsdPerTransfer', '500'])
    chainer(dir, ['config', 'set', 'maxUsdPerTransfer', 'off'])
    assert.equal(settingsOf(dir).maxUsdPerTransfer, null)
  })

  test('a negative per-transfer limit is refused', (t) => {
    assert.equal(chainer(home(t), ['config', 'set', 'maxUsdPerTransfer', '-1']).code, 1)
  })

  test('a preference other than cheapest or fastest is refused', (t) => {
    assert.match(chainer(home(t), ['config', 'set', 'prefer', 'safest']).err, /prefer must be "cheapest" or "fastest"/)
  })

  test('an unknown setting is refused by name', (t) => {
    assert.equal(chainer(home(t), ['config', 'set', 'colour', 'blue']).err.trim(), 'Error: Unknown setting "colour"')
  })

  test('BlockCypher can be allowed', (t) => {
    const dir = home(t)
    chainer(dir, ['config', 'set', 'blockcypher', 'on'])
    assert.equal(settingsOf(dir).blockcypher, true)
  })

  test('a token added to the avoid list twice, in different case, is listed once', (t) => {
    const dir = home(t)
    chainer(dir, ['config', 'avoid', 'add', 'USDT'])
    chainer(dir, ['config', 'avoid', 'add', 'usdt'])
    assert.deepEqual(settingsOf(dir).avoidTokens, ['usdt'])
  })

  test('a token removed from the avoid list is gone, in any case', (t) => {
    const dir = home(t)
    chainer(dir, ['config', 'avoid', 'add', 'USDT'])
    chainer(dir, ['config', 'avoid', 'remove', 'Usdt'])
    assert.deepEqual(settingsOf(dir).avoidTokens, [])
  })

  test('changing one setting keeps the others', (t) => {
    const dir = home(t)
    chainer(dir, ['config', 'set', 'slippage', '0.01'])
    chainer(dir, ['config', 'set', 'maxHops', '2'])
    assert.deepEqual([settingsOf(dir).slippage, settingsOf(dir).maxHops], [0.01, 2])
  })

  test('a damaged settings file stops the command with its name', (t) => {
    const dir = home(t)
    writeFileSync(join(dir, 'settings.json'), '{"slippage":')
    const r = chainer(dir, ['config', 'show'])
    assert.deepEqual([r.code, r.err.trim().split('\n').length, r.err.startsWith('Error: The settings file (settings.json) is damaged')], [1, 1, true])
  })

  // ---- saved routes and history ----

  test('listing saved routes before there are any says how to save one', (t) => {
    assert.equal(chainer(home(t), ['route', 'list']).out.trim(), 'No saved routes. Save one with "chainer route save <name> ...".')
  })

  test('removing a saved route that does not exist fails', (t) => {
    const r = chainer(home(t), ['route', 'remove', 'nightly'])
    assert.deepEqual([r.code, r.err.trim()], [1, 'Error: No saved route "nightly"'])
  })

  test('route remove ../keystore fails and leaves the wallet file as it was', (t) => {
    const dir = home(t)
    chainer(dir, ['wallet', 'import'], { input: `${SEED}\n`, password: 'correct horse' })
    const before = readFileSync(join(dir, 'keystore.json'), 'utf8')
    const r = chainer(dir, ['route', 'remove', '../keystore'])
    assert.deepEqual([r.code, readFileSync(join(dir, 'keystore.json'), 'utf8') === before], [1, true])
  })

  test('an unknown option fails with one line, not a stack trace', (t) => {
    const r = chainer(home(t), ['status', '--bogus'])
    assert.deepEqual([r.code, r.err.trim().split('\n').length, r.err.startsWith("Error: Unknown option '--bogus'")], [1, 1, true])
  })

  test('piped input that ends before every question is answered fails instead of quietly succeeding', (t) => {
    const dir = home(t)
    const r = chainer(dir, ['wallet', 'import'], { input: `${SEED}\n` })
    assert.deepEqual([r.code, lastError(r.err), existsSync(join(dir, 'keystore.json'))], [1, 'Error: The input ended before this was answered: Choose a wallet password (min. 8 characters):', false])
  })

  test('the password and its repetition can both be piped in', (t) => {
    const dir = home(t)
    const r = chainer(dir, ['wallet', 'import'], { input: `${SEED}\nsame-password\nsame-password\n` })
    assert.deepEqual([r.code, existsSync(join(dir, 'keystore.json'))], [0, true])
  })

  test('the history before any transfer says there are no runs', (t) => {
    assert.equal(chainer(home(t), ['status']).out.trim(), 'No runs yet.')
  })
})
