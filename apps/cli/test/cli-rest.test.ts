// The real chainer command against a fake network: the remaining paths (terminal-only behaviour,
// Ctrl-C, stop-over gas, unusual wallets and every setting).
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { chainer, home, KEY, lastError, ME, PASSWORD, SEED, standardWorld, TOKENS, ZERO } from './run.ts'
import type { World } from '../../../testing/fakenet/world.ts'

const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
const send100 = ['send', '100', 'USDC', 'arb', 'bas']
const OTHER_SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

/** USDC from Arbitrum to LINK on Ethereum through a USDC stop-over on Ethereum, where the wallet has no ETH. */
const viaEthereum = (over: Partial<World> = {}) =>
  standardWorld({
    balances: { [ME]: { [`arb:${TOKENS.usdcArb.address}`]: '1000000000', [`arb:${ZERO}`]: '10000000000000000' } },
    routes: [
      { from: 'USDC@arb', to: 'USDC@eth', tool: 'stargate', rate: 0.999 },
      { from: 'USDC@eth', to: 'LINK@eth', tool: '1inch', rate: 0.0666 },
      { from: 'USDC@arb', to: 'ETH@eth', tool: 'stargate', rate: 0.000333 },
    ],
    ...over,
  })
const toLink = ['send', '100', 'USDC', 'arb', 'LINK', 'eth']

describe('remaining paths', { concurrency: true }, () => {
  // ---- display ----

  test('a route that takes hours shows its time in hours', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999, seconds: 7200 }] })
    assert.match((await chainer(await home(t), world, ['quote', '1', 'USDC', 'arb', 'bas'])).out, /\s2\.0 h$/m)
  })

  test('the wallet list shows each wallet’s addresses, and transit wallets with their chain', async (t) => {
    const dir = await home(t, { more: [{ name: 'transit-arb-1', secret: OTHER_SEED, transit: { chainKey: 'arb', createdAt: '2026-11-26T00:00:00Z' } }] })
    const r = await chainer(dir, standardWorld(), ['wallet', 'list'])
    assert.deepEqual([r.out.split('\n')[0]!.split(/\s+/), new RegExp(`^main\\s+seed\\s+${ME}\\s`, 'm').test(r.out), /^transit-arb-1\s+transit \(arb\)\s+0x/m.test(r.out)], [['NAME', 'TYPE', 'EVM', 'SOL', 'BTC', 'LTC', 'DOGE', 'BCH', 'DASH'], true, true])
  })

  test('a wallet from a private key shows a dash for chains it has no address on', async (t) => {
    const r = await chainer(await home(t, { secret: KEY }), standardWorld(), ['wallet', 'list'])
    assert.match(r.out, /^main\s+key\s+0x\S+\s+-\s+-\s+-\s+-\s+-\s+-$/m)
  })

  // ---- wallets without an address on a chain ----

  test('a wallet from a private key has no address on Litecoin and says to import a seed phrase', async (t) => {
    const r = await chainer(await home(t, { secret: KEY }), standardWorld(), ['balances', 'ltc'])
    assert.equal(lastError(r.err), 'Error: Wallet "main" was made from a single EVM private key and has no address on Litecoin. Import a seed phrase to use it.')
  })

  test('an older seed wallet without a Litecoin address is told to refresh', async (t) => {
    const dir = await home(t)
    const ks = JSON.parse(readFileSync(join(dir, 'keystore.json'), 'utf8'))
    delete ks.accounts[0].addresses.ltc
    writeFileSync(join(dir, 'keystore.json'), JSON.stringify(ks))
    assert.equal(lastError((await chainer(dir, standardWorld(), ['balances', 'ltc'])).err), 'Error: Wallet "main" has no Litecoin address stored yet. Run "chainer wallet refresh" once to add the new chains.')
  })

  // ---- settings ----

  test('the preference can be set to fastest', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['config', 'set', 'prefer', 'fastest'])
    assert.equal(settingsOf(dir).prefer, 'fastest')
  })

  test('the gas top-up mode can be set', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['config', 'set', 'gasTopUpMode', 'fixed'])
    assert.equal(settingsOf(dir).gasTopUp.mode, 'fixed')
  })

  test('an unknown gas top-up mode is refused', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['config', 'set', 'gasTopUpMode', 'sometimes'])).err), 'Error: gasTopUpMode must be "off", "multiplier" or "fixed"')
  })

  test('the gas top-up multiplier can be set', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['config', 'set', 'gasTopUpMultiplier', '3'])
    assert.deepEqual([settingsOf(dir).gasTopUp.mode, settingsOf(dir).gasTopUp.multiplier], ['multiplier', 3])
  })

  test('the fixed gas top-up can be set in dollars', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['config', 'set', 'gasTopUpFixedUsd', '5'])
    assert.deepEqual([settingsOf(dir).gasTopUp.mode, settingsOf(dir).gasTopUp.fixedUsd], ['fixed', 5])
  })

  test('an unknown config subcommand shows how to use it', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['config', 'reset'])).err), 'Error: Use: chainer config show | set <key> <value> | rpc <chain> <url|default> | avoid <add|remove> <token>')
  })

  // ---- stop-over gas ----

  test('gas for a stop-over is sent first, then the route', async (t) => {
    const r = await chainer(await home(t), viaEthereum(), [...toLink, '--yes'])
    const at = (s: string) => r.out.indexOf(s)
    assert.deepEqual([at('Sending gas to eth first') >= 0, at('Sending gas to eth first') < at('Done. Received')], [true, true])
  })

  test('stop-over gas without a route to the chain’s coin stops before anything is sent', async (t) => {
    const world = viaEthereum({ routes: viaEthereum().routes!.slice(0, 2) })
    const r = await chainer(await home(t), world, [...toLink, '--yes'])
    assert.deepEqual([lastError(r.err), r.broadcasts], ['Error: Cannot send gas ahead to Ethereum: No route found, also not through other chains.. Turn the gas top-up off (--gas-topup off) or get some ETH there first.', []])
  })

  test('stop-over gas that cannot be priced stops before anything is sent', async (t) => {
    // The next leg is quoted without cost and the chain's coin has no price, so the gas cannot be sized.
    const world = viaEthereum({ chains: standardWorld().chains.map((c) => (c.key === 'eth' ? { ...c, price: undefined } : c)), routes: [{ from: 'USDC@arb', to: 'USDC@eth', tool: 'stargate', rate: 0.999 }, { from: 'USDC@eth', to: 'LINK@eth', tool: '1inch', rate: 0.0666, gasUsd: 0 }] })
    const r = await chainer(await home(t), world, [...toLink, '--yes'])
    assert.match(lastError(r.err) ?? '', /^Error: Cannot send gas ahead to Ethereum: the gas price of the destination chain is unknown/)
  })

  test('a plan’s dry run notes stop-over gas it cannot arrange instead of stopping', async (t) => {
    const dir = await home(t)
    const plan = join(dir, 'plan.yaml')
    writeFileSync(plan, 'legs:\n  - { amount: 100, from: USDC@arb, to: USDC@eth }\n  - { amount: all, from: USDC@eth, to: LINK@eth }\n')
    const world = viaEthereum({ routes: viaEthereum().routes!.slice(0, 2) })
    const r = await chainer(dir, world, ['pipeline', 'run', plan, '--dry-run'])
    assert.match(r.out, /^Note: Cannot send gas ahead to Ethereum: /m)
  })

  test('a plan run that cannot arrange its stop-over gas stops before anything is sent', async (t) => {
    const dir = await home(t)
    const plan = join(dir, 'plan.yaml')
    writeFileSync(plan, 'legs:\n  - { amount: 100, from: USDC@arb, to: USDC@eth }\n  - { amount: all, from: USDC@eth, to: LINK@eth }\n')
    const r = await chainer(dir, viaEthereum({ routes: viaEthereum().routes!.slice(0, 2) }), ['pipeline', 'run', plan, '--yes'])
    assert.deepEqual([r.code, r.broadcasts], [1, []])
  })

  test('a sweep transfer that cannot pay its stop-over gas is reported and the command fails', async (t) => {
    const world = viaEthereum({ routes: viaEthereum().routes!.slice(0, 2) })
    // The whole USDC balance is swept, so nothing is left to pay the stop-over gas with.
    const r = await chainer(await home(t), world, ['sweep', 'arb', 'eth', '--target', 'LINK', '--tokens', 'USDC', '--yes'])
    assert.deepEqual([r.code, /^USDC stopped: The wallet cannot pay the gas for Ethereum \(about 0\.20 USD\) on top of the transfer; send a smaller amount, or turn the gas top-up off$/m.test(r.out)], [1, true])
  })

  test('a scheduled sweep waits while its total fees are above the limit', async (t) => {
    const dir = await home(t)
    const world = standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999, gasUsd: 0.5 }] })
    await chainer(dir, world, ['route', 'save-sweep', 'tidy', 'arb', 'bas', '--tokens', 'USDC'])
    await chainer(dir, world, ['schedule', 'add', 'tidy', '--when-fees-below', '0.1'], { input: 'yes\n' })
    const r = await chainer(dir, world, ['daemon', '--once'])
    assert.deepEqual([r.out.includes('Gas and fees are $0.50 in total, above the limit of $0.10; waiting.'), r.broadcasts], [true, []])
  })

  // ---- Ctrl-C ----

  test('Ctrl-C while a transfer is under way says it continues on chain and how to pick it up', async (t) => {
    // The bridge never finishes, so the run is still following it when Ctrl-C comes.
    const r = await chainer(await home(t), standardWorld({ status: 'PENDING' }), [...send100, '--yes'], { signalWhen: ({ log }) => log.filter((l) => l.kind === 'request' && l.url.includes('/v1/status')).length > 0 })
    assert.deepEqual([r.code, /Stopped\. A transaction already submitted continues on-chain; pick the run up again with "chainer resume [0-9a-f]{8}"\./.test(r.err)], [130, true])
  })

  test('the daemon keeps checking until Ctrl-C, then stops', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['daemon', '--poll', '60'], { signalWhen: ({ stdout }) => stdout.includes('Daemon started') })
    assert.deepEqual([r.out.includes('Daemon started, checking every 60 s; Ctrl-C stops it'), r.out.trim().split('\n').at(-1)!.endsWith('Daemon stopped')], [true, true])
  })

  // ---- on a terminal ----

  test('on a terminal the run is drawn as a list that updates in place', async (t) => {
    const r = await chainer(await home(t), standardWorld(), [...send100, '--yes'], { tty: true })
    assert.deepEqual([r.out.includes('\x1b[J'), /✔ 1\. 100 USDC arb -> USDC bas via lifi\/stargate: received 99\.9 USDC/.test(r.out)], [true, true])
  })

  test('on a terminal the seed phrase is typed hidden, and backspace corrects it', async (t) => {
    const dir = await home(t, { wallet: false })
    // "abandonX" corrected with backspace to "abandon", then the rest of the phrase.
    const typed = `${SEED.replace('abandon', 'abandonX\x7f')}\r`
    const r = await chainer(dir, standardWorld(), ['wallet', 'import'], { tty: true, answers: [[/Seed phrase or private key \(input hidden\): /, typed]] })
    assert.deepEqual([r.out.includes(`Wallet "main" saved. EVM address: ${ME}`), r.out.includes('abandon abandon')], [true, false])
  })

  test('on a terminal Ctrl-C at a hidden prompt cancels', async (t) => {
    const dir = await home(t, { wallet: false })
    const r = await chainer(dir, standardWorld(), ['wallet', 'import'], { tty: true, answers: [[/Seed phrase or private key/, '\x03']] })
    assert.match(r.out, /Error: Cancelled/)
  })

  test('without CHAINER_PASSWORD the password is asked once on the terminal and kept for the run', async (t) => {
    const r = await chainer(await home(t), standardWorld(), [...send100], { tty: true, password: null, answers: [[/\[y\/N\] /, 'y\r'], [/Wallet password: /, `${PASSWORD}\r`]] })
    assert.deepEqual([r.out.match(/Wallet password: /g)?.length, r.out.includes('Done. Received 99.9 USDC')], [1, true])
  })

  test('a new wallet’s password is asked twice on the terminal', async (t) => {
    const dir = await home(t, { wallet: false })
    const r = await chainer(dir, standardWorld(), ['wallet', 'import'], {
      tty: true,
      password: null,
      answers: [
        [/Seed phrase or private key/, `${SEED}\r`],
        [/Choose a wallet password/, `${PASSWORD}\r`],
        [/Repeat the password: /, `${PASSWORD}\r`],
      ],
    })
    assert.match(r.out, new RegExp(`Wallet "main" saved\\. EVM address: ${ME}`))
  })
})
