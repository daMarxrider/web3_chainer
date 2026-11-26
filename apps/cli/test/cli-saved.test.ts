// The real chainer command against a fake network: saved routes, sweeps, plan files, schedules and the daemon.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { decodeFunctionData, erc20Abi } from 'viem'
import { chainer, DIAMOND, FRIEND, home, lastError, ME, standardWorld, TOKENS, ZERO } from './run.ts'
import type { World } from '../../../testing/fakenet/world.ts'

const approvedAmount = (data: `0x${string}`) => (decodeFunctionData({ abi: erc20Abi, data }).args as readonly [string, bigint])[1]
const saveNightly = (dir: string, world: World = standardWorld(), extra: string[] = []) => chainer(dir, world, ['route', 'save', 'nightly', '100', 'USDC', 'arb', 'bas', ...extra])

describe('saved routes, sweeps, plans and schedules', { concurrency: true }, () => {
  // ---- saving routes ----

  test('a saved route keeps its tokens, amount and path', async (t) => {
    assert.equal((await saveNightly(await home(t))).out.trim(), 'Saved "nightly": fixed amount USDC@arb -> USDC@bas via lifi/stargate')
  })

  test('a saved route keeps a minimum and the fallback when asked', async (t) => {
    const r = await saveNightly(await home(t), standardWorld(), ['--min', '99', '--fallback'])
    assert.equal(r.out.trim(), 'Saved "nightly": fixed amount USDC@arb -> USDC@bas via lifi/stargate (best route if gone), min 99000000')
  })

  test('a route saved for "all" keeps "all", quoted on the current balance', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['route', 'save', 'everything', 'all', 'USDC', 'arb', 'bas'])
    assert.equal(r.out.trim(), 'Saved "everything": all USDC@arb -> USDC@bas via lifi/stargate')
  })

  test('a route for "all" of a token the wallet does not hold is refused', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['route', 'save', 'x', 'all', 'LINK', 'eth', 'bas'])
    assert.equal(lastError(r.err), 'Error: The wallet holds no LINK on Ethereum to base the route on')
  })

  test('saving a route with too few details shows how', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['route', 'save', 'x', '100', 'USDC'])).err), 'Error: Use: chainer route save <name> <amount|all> <token> <chain> [<to-token>] <to-chain>')
  })

  test('routes are not saved on test networks', async (t) => {
    assert.match(lastError((await saveNightly(await home(t), standardWorld(), ['--testnet'])).err) ?? '', /^Error: Save routes without --testnet/)
  })

  test('saved routes are listed with what they do', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    assert.deepEqual((await chainer(dir, standardWorld(), ['route', 'list'])).out.trim().split('\n'), ['NAME     WHAT', 'nightly  fixed amount USDC@arb -> USDC@bas via lifi/stargate'])
  })

  test('saved routes are listed as JSON', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    assert.equal(JSON.parse((await chainer(dir, standardWorld(), ['route', 'list', '--json'])).out)[0].amount, '100000000')
  })

  test('a saved route is shown in full', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    assert.equal(JSON.parse((await chainer(dir, standardWorld(), ['route', 'show', 'nightly'])).out).via, 'lifi/stargate')
  })

  test('a saved route is removed', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    await chainer(dir, standardWorld(), ['route', 'remove', 'nightly'])
    assert.match((await chainer(dir, standardWorld(), ['route', 'list'])).out, /^No saved routes\./)
  })

  test('a route subcommand without a name shows how to use it', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['route', 'show'])).err), 'Error: Use: chainer route save | save-sweep | list | show | remove | run')
  })

  test('an unknown route subcommand shows how to use it', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['route', 'burn', 'x'])).err), 'Error: Use: chainer route save | save-sweep | list | show | remove | run')
  })

  test('a saved sweep keeps its chains, tokens and target', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['route', 'save-sweep', 'tidy', 'arb', 'bas', '--tokens', 'USDC,ETH', '--target', 'USDC'])
    assert.equal(r.out.trim(), 'Saved "tidy": sweep arb -> bas of USDC,ETH as USDC')
  })

  test('a saved sweep needs both chains', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['route', 'save-sweep', 'tidy', 'arb'])).err), 'Error: Use: chainer route save-sweep <name> <from-chain> <to-chain> [--tokens ...] [--target ...]')
  })

  test('sweeps are not saved on test networks', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['route', 'save-sweep', 'tidy', 'arb', 'bas', '--testnet'])).err), 'Error: Save routes without --testnet')
  })

  // ---- running saved routes ----

  test('a saved route runs along its saved path', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    const r = await chainer(dir, standardWorld(), ['route', 'run', 'nightly', '--yes'])
    assert.deepEqual([r.out.includes('Route:     lifi/stargate'), r.out.trim().split('\n').at(-1)], [true, `Done. Received 99.9 USDC at ${ME}`])
  })

  test('a dry run of a saved route sends nothing', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    const r = await chainer(dir, standardWorld(), ['route', 'run', 'nightly', '--dry-run'])
    assert.deepEqual([r.out.trim().split('\n').at(-1), r.broadcasts], ['Dry run: nothing was signed or sent.', []])
  })

  test('declining a saved route’s run sends nothing', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    const r = await chainer(dir, standardWorld(), ['route', 'run', 'nightly'], { input: 'n\n' })
    assert.deepEqual([r.out.trim().split('\n').at(-1), r.broadcasts], ['Cancelled.', []])
  })

  const hopOnly = () => standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'hop', rate: 0.998 }] })

  test('a saved route whose path is gone stops, without a fallback', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    const r = await chainer(dir, hopOnly(), ['route', 'run', 'nightly', '--yes'])
    assert.deepEqual([lastError(r.err), r.broadcasts], ['Error: The saved path "lifi/stargate" is no longer offered. Run it again with the fallback allowed, or save a new route.', []])
  })

  test('a saved route whose path is gone takes the best route now, with the fallback', async (t) => {
    const dir = await home(t)
    await saveNightly(dir, standardWorld(), ['--fallback'])
    const r = await chainer(dir, hopOnly(), ['route', 'run', 'nightly', '--dry-run'])
    assert.match(r.out, /^The saved path "lifi\/stargate" is gone; using the best route now: lifi\/hop$/m)
  })

  test('a saved route whose result is below its minimum sends nothing', async (t) => {
    const dir = await home(t)
    await saveNightly(dir, standardWorld(), ['--min', '99.9'])
    const r = await chainer(dir, standardWorld(), ['route', 'run', 'nightly', '--yes'])
    assert.deepEqual([lastError(r.err), r.broadcasts], ['Error: The result (99400500 at worst) is below the minimum you saved (99900000); nothing was sent', []])
  })

  test('a route saved for "all" sends the whole balance at the time it runs', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['route', 'save', 'everything', 'all', 'USDC', 'arb', 'bas'])
    const r = await chainer(dir, standardWorld(), ['route', 'run', 'everything', '--yes'])
    assert.equal(approvedAmount(r.broadcasts[0]!.data!), 1_000_000_000n)
  })

  test('a saved route for more than the wallet holds is refused', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    const r = await chainer(dir, standardWorld({ balances: {} }), ['route', 'run', 'nightly', '--yes'])
    assert.equal(lastError(r.err), 'Error: The wallet holds 0 USDC on Arbitrum, not enough for this saved route')
  })

  test('a saved route keeps its recipient', async (t) => {
    const dir = await home(t)
    await saveNightly(dir, standardWorld(), ['--to', FRIEND])
    const r = await chainer(dir, standardWorld(), ['route', 'run', 'nightly', '--yes'])
    assert.equal(r.out.trim().split('\n').at(-1), `Done. Received 99.9 USDC at ${FRIEND}`)
  })

  test('running a saved route that does not exist says how to list them', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['route', 'run', 'nope'])).err), 'Error: No saved route "nope". List them with "chainer route list".')
  })

  // ---- sweeps ----

  const sweepWorld = (over: Partial<World> = {}) =>
    standardWorld({
      routes: [
        { from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 },
        { from: 'ETH@arb', to: 'ETH@bas', tool: 'stargate', rate: 0.999, gasUsd: 0.05 },
      ],
      ...over,
    })

  test('a sweep plan lists each token’s transfer, the coin last, and the recipient', async (t) => {
    const r = await chainer(await home(t), sweepWorld(), ['sweep', 'arb', 'bas', '--dry-run'])
    const rows = r.out.split('\n').filter((l) => /^(USDC|ETH)\s/.test(l)).map((l) => l.split(/\s{2,}/)[0])
    assert.deepEqual([rows, r.out.includes(`Recipient: ${ME} on Base`), r.out.trim().split('\n').at(-1)], [['USDC', 'ETH'], true, 'Dry run: nothing was signed or sent.'])
  })

  test('tokens a sweep cannot move are listed with the reason', async (t) => {
    const r = await chainer(await home(t), sweepWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 }] }), ['sweep', 'arb', 'bas', '--dry-run'])
    assert.match(r.out, /^Skipped:\n {2}ETH: no route$/m)
  })

  test('a sweep with nothing to move says so', async (t) => {
    const r = await chainer(await home(t), sweepWorld({ balances: {} }), ['sweep', 'arb', 'bas'])
    assert.equal(r.out.trim().split('\n').at(-1), 'Nothing to send.')
  })

  test('a sweep sends each token as its own transfer', async (t) => {
    const r = await chainer(await home(t), sweepWorld(), ['sweep', 'arb', 'bas', '--yes'])
    assert.deepEqual([r.out.includes('[1/2] USDC'), r.out.includes('[2/2] ETH'), r.broadcasts.filter((b) => b.to === DIAMOND.toLowerCase()).length], [true, true, 2])
  })

  test('a sweep limited to some tokens moves only those', async (t) => {
    const r = await chainer(await home(t), sweepWorld(), ['sweep', 'arb', 'bas', '--tokens', 'USDC', '--yes'])
    assert.deepEqual(r.broadcasts.filter((b) => b.to === DIAMOND.toLowerCase()).length, 1)
  })

  test('a sweep into one target token asks for routes to that token', async (t) => {
    const world = sweepWorld({ routes: [{ from: 'USDC@arb', to: 'ETH@bas', tool: 'stargate', rate: 0.000333 }, { from: 'ETH@arb', to: 'ETH@bas', tool: 'stargate', rate: 0.999 }] })
    const r = await chainer(await home(t), world, ['sweep', 'arb', 'bas', '--target', 'ETH', '--dry-run'])
    assert.match(r.out, /^USDC\s+1000 USDC\s+0\.333 ETH\s/m)
  })

  test('declining a sweep sends nothing', async (t) => {
    const r = await chainer(await home(t), sweepWorld(), ['sweep', 'arb', 'bas'], { input: 'n\n' })
    assert.deepEqual([r.out.trim().split('\n').at(-1), r.broadcasts], ['Cancelled.', []])
  })

  test('a sweep transfer that fails is reported and the command fails, after the others ran', async (t) => {
    const r = await chainer(await home(t), sweepWorld({ receipt: 'reverted' }), ['sweep', 'arb', 'bas', '--yes'])
    assert.deepEqual([r.code, r.out.includes('[2/2] ETH')], [1, true])
  })

  test('a sweep says when the curated token list could not be loaded', async (t) => {
    const r = await chainer(await home(t), sweepWorld(), ['sweep', 'arb', 'bas', '--dry-run'])
    assert.match(r.out, /^Note: The token list could not be loaded \(tokens\.uniswap\.org responded 404: not found\); tokens are judged by LI\.FI's screening only$/m)
  })

  test('a sweep never moves a token LI.FI flags as a scam', async (t) => {
    const world = sweepWorld({ tokens: [...Object.values(TOKENS), { chain: 'arb', symbol: 'FREE', address: '0x9999999999999999999999999999999999999999', decimals: 18, price: 1, status: 'flagged' }], balances: { [ME]: { [`arb:0x9999999999999999999999999999999999999999`]: '5000000000000000000' } } })
    const r = await chainer(await home(t), world, ['sweep', 'arb', 'bas', '--dry-run'])
    assert.equal(r.out.trim().split('\n').at(-1), 'Nothing to send.')
  })

  test('a sweep into a flagged target token is refused', async (t) => {
    const world = sweepWorld({ tokens: [...Object.values(TOKENS), { chain: 'bas', symbol: 'FREE', address: '0x9999999999999999999999999999999999999999', decimals: 18, status: 'flagged' }] })
    assert.equal(lastError((await chainer(await home(t), world, ['sweep', 'arb', 'bas', '--target', 'FREE'])).err), 'Error: FREE on Base is flagged by LI.FI\'s token screening as a likely scam')
  })

  test('a sweep plan as JSON lists items and skipped tokens', async (t) => {
    // Nothing but the JSON on stdout, so it can be piped into another program.
    const plan = JSON.parse((await chainer(await home(t), sweepWorld(), ['sweep', 'arb', 'bas', '--json'])).out)
    assert.deepEqual(plan.items.map((i: { from: string }) => i.from), ['USDC', 'ETH'])
  })

  test('a sweep needs exactly two chains', async (t) => {
    assert.equal(lastError((await chainer(await home(t), sweepWorld(), ['sweep', 'arb'])).err), 'Error: Use: chainer sweep <from-chain> <to-chain> [--tokens USDC,DAI] [--target USDC]')
  })

  test('a saved sweep runs as a sweep', async (t) => {
    const dir = await home(t)
    await chainer(dir, sweepWorld(), ['route', 'save-sweep', 'tidy', 'arb', 'bas', '--tokens', 'USDC'])
    const r = await chainer(dir, sweepWorld(), ['route', 'run', 'tidy', '--dry-run'])
    assert.match(r.out, /^USDC\s+1000 USDC/m)
  })

  // ---- plan files ----

  const planFile = (dir: string, yaml: string) => {
    const path = join(dir, 'plan.yaml')
    writeFileSync(path, yaml)
    return path
  }
  const twoLegs = 'legs:\n  - { amount: 100, from: USDC@arb, to: USDC@bas }\n  - { amount: all, from: USDC@bas, to: ETH@bas }\n'
  const planWorld = () =>
    standardWorld({
      balances: { [ME]: { [`arb:${TOKENS.usdcArb.address}`]: '1000000000', [`bas:${TOKENS.usdcBas.address}`]: '99900000', [`bas:${ZERO}`]: '10000000000000000', [`arb:${ZERO}`]: '10000000000000000' } },
      routes: [
        { from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 },
        { from: 'USDC@bas', to: 'ETH@bas', tool: 'uniswap', rate: 0.000333 },
      ],
    })

  test('a plan file is listed leg by leg and quoted on a dry run, later legs with what arrives at worst', async (t) => {
    const dir = await home(t)
    const r = await chainer(dir, planWorld(), ['pipeline', 'run', planFile(dir, twoLegs), '--dry-run'])
    assert.deepEqual(r.out.trim().split('\n').slice(0, 3).concat(r.out.trim().split('\n').slice(-3)), [
      'Plan with 2 legs, wallet main:',
      '  1. 100 USDC arb -> USDC bas',
      '  2. all USDC bas -> ETH bas',
      '  1. would receive 99.9 USDC (at worst 99.4005 USDC) via lifi/stargate, about 60 s',
      '  2. would receive 0.0331 ETH (at worst 0.032934 ETH) via lifi/uniswap, about 60 s',
      'Dry run: nothing was signed or sent.',
    ])
  })

  test('a plan file runs every leg in order once confirmed', async (t) => {
    const dir = await home(t)
    const r = await chainer(dir, planWorld(), ['pipeline', 'run', planFile(dir, twoLegs)], { input: 'y\nyes\n' })
    assert.match(r.out.trim().split('\n').at(-1)!, /^Done\. Received [\d.]+ ETH at /)
  })

  test('a plan file whose first leg sends everything is quoted only when it runs', async (t) => {
    const dir = await home(t)
    const r = await chainer(dir, planWorld(), ['pipeline', 'run', planFile(dir, 'legs:\n  - { amount: all, from: USDC@arb, to: USDC@bas }\n'), '--dry-run'])
    assert.match(r.out, /^ {2}1\. sends the whole balance; quoted when it runs$/m)
  })

  test('a plan file without legs is refused', async (t) => {
    const dir = await home(t)
    assert.equal(lastError((await chainer(dir, planWorld(), ['pipeline', 'run', planFile(dir, 'wallet: main\n')])).err), 'Error: The plan file needs a "legs" list (see chainer --help)')
  })

  test('a plan leg without its tokens is refused by number', async (t) => {
    const dir = await home(t)
    assert.equal(lastError((await chainer(dir, planWorld(), ['pipeline', 'run', planFile(dir, 'legs:\n  - { amount: 1, from: USDC@arb }\n')])).err), 'Error: Leg 1 needs "amount", "from" and "to"')
  })

  test('a plan leg that sends elsewhere before the last leg is refused', async (t) => {
    const dir = await home(t)
    const yaml = `legs:\n  - { amount: 100, from: USDC@arb, to: USDC@bas, recipient: "${FRIEND}" }\n  - { amount: all, from: USDC@bas, to: ETH@bas }\n`
    assert.equal(lastError((await chainer(dir, planWorld(), ['pipeline', 'run', planFile(dir, yaml)])).err), 'Error: Leg 1 sends to another address, so the next leg would have nothing to continue with')
  })

  test('a plan token written without its chain is refused with an example', async (t) => {
    const dir = await home(t)
    assert.equal(lastError((await chainer(dir, planWorld(), ['pipeline', 'run', planFile(dir, 'legs:\n  - { amount: 1, from: USDC, to: USDC@bas }\n')])).err), 'Error: "USDC" should look like TOKEN@chain, e.g. USDC@arbitrum')
  })

  test('pipeline without a plan file shows how to use it', async (t) => {
    assert.equal(lastError((await chainer(await home(t), planWorld(), ['pipeline', 'run'])).err), 'Error: Use: chainer pipeline run <plan.yaml>')
  })

  test('declining a plan sends nothing', async (t) => {
    const dir = await home(t)
    const r = await chainer(dir, planWorld(), ['pipeline', 'run', planFile(dir, twoLegs)], { input: 'n\n' })
    assert.deepEqual([r.out.trim().split('\n').at(-1), r.broadcasts], ['Cancelled.', []])
  })

  // ---- schedules and the daemon ----

  const scheduleAt = (dir: string, when: string, world: World = standardWorld()) => chainer(dir, world, ['schedule', 'add', 'nightly', '--at', when], { input: 'yes\n' })

  test('a schedule is added for a saved route, with the location answered now', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    const r = await scheduleAt(dir, '2030-01-01T00:00:00Z')
    assert.match(r.out, /^Scheduled "nightly" once at 2030-01-01 \d\d:\d\d \(id [0-9a-f]{8}\)\. Start "chainer daemon" to carry it out; it must stay running\.$/m)
  })

  test('schedules are listed with their trigger', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    await chainer(dir, standardWorld(), ['schedule', 'add', 'nightly', '--every', '6h'], { input: 'yes\n' })
    assert.match((await chainer(dir, standardWorld(), ['schedule', 'list'])).out, /^[0-9a-f]{8}\s+nightly\s+every 360 min\s+-$/m)
  })

  test('a fee condition is listed with its limit and interval', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    await chainer(dir, standardWorld(), ['schedule', 'add', 'nightly', '--when-fees-below', '0.5', '--check-every', '10m', '--repeat'], { input: 'yes\n' })
    assert.match((await chainer(dir, standardWorld(), ['schedule'])).out, /when fees are at most \$0\.50 \(checked every 10 min, repeating\)/)
  })

  test('without schedules the list says how to add one', async (t) => {
    assert.equal((await chainer(await home(t), standardWorld(), ['schedule', 'list'])).out.trim(), 'No schedules. Add one with "chainer schedule add <route> --at <time>".')
  })

  test('schedules are listed as JSON', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    await scheduleAt(dir, '2030-01-01T00:00:00Z')
    assert.equal(JSON.parse((await chainer(dir, standardWorld(), ['schedule', 'list', '--json'])).out)[0].route, 'nightly')
  })

  test('a schedule is removed by the start of its id', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    const id = /id ([0-9a-f]{8})/.exec((await scheduleAt(dir, '2030-01-01T00:00:00Z')).out)![1]!
    assert.equal((await chainer(dir, standardWorld(), ['schedule', 'remove', id.slice(0, 4)])).out.trim(), 'Removed the schedule for "nightly".')
  })

  test('a schedule needs exactly one trigger', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    assert.equal(lastError((await chainer(dir, standardWorld(), ['schedule', 'add', 'nightly', '--at', '2030-01-01', '--every', '1h'])).err), 'Error: Give exactly one of --at, --every or --when-fees-below')
  })

  test('a fee condition needs an amount', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    assert.equal(lastError((await chainer(dir, standardWorld(), ['schedule', 'add', 'nightly', '--when-fees-below', 'cheap'])).err), 'Error: --when-fees-below needs an amount in USD')
  })

  test('a schedule time that is not a time is refused with an example', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    assert.equal(lastError((await chainer(dir, standardWorld(), ['schedule', 'add', 'nightly', '--at', 'tomorrow'])).err), 'Error: "tomorrow" is not a time; use e.g. 2026-12-01T10:00 (your local time) or 2026-12-01T10:00:00Z')
  })

  test('schedules are not made for test networks', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    assert.match(lastError((await chainer(dir, standardWorld(), ['schedule', 'add', 'nightly', '--at', '2030-01-01', '--testnet'])).err) ?? '', /^Error: Schedules run on the main networks/)
  })

  test('a schedule subcommand without what it needs shows how', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['schedule', 'add'])).err), 'Error: Use: chainer schedule add <route> --at|--every|--when-fees-below ... | list | remove <id>')
  })

  test('without the location confirmation a schedule may not use restricted bridges', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    const r = await chainer(dir, standardWorld(), ['schedule', 'add', 'nightly', '--at', '2030-01-01T00:00:00Z'], { input: 'no\n' })
    assert.match(r.out, /^Without the confirmation these bridges are left out; the plan continues with the others\.$/m)
  })

  test('the daemon runs a schedule that is due, once, and marks it done', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    await scheduleAt(dir, '2020-01-01T00:00:00Z')
    const r = await chainer(dir, standardWorld(), ['daemon', '--once'])
    const list = await chainer(dir, standardWorld(), ['schedule', 'list'])
    assert.deepEqual([r.out.includes('Running "nightly"'), r.out.includes(`Done. Received 99.9 USDC at ${ME}`), /\sdone\s/.test(list.out)], [true, true, true])
  })

  test('the daemon leaves a schedule that is not due yet', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    await scheduleAt(dir, '2099-01-01T00:00:00Z')
    const r = await chainer(dir, standardWorld(), ['daemon', '--once'])
    assert.deepEqual([r.out.includes('Running'), r.broadcasts], [false, []])
  })

  test('the daemon waits when fees are above a schedule’s limit, and sends nothing', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    await chainer(dir, standardWorld(), ['schedule', 'add', 'nightly', '--when-fees-below', '0.01'], { input: 'yes\n' })
    const r = await chainer(dir, standardWorld(), ['daemon', '--once'])
    const list = await chainer(dir, standardWorld(), ['schedule', 'list'])
    assert.deepEqual([r.out.includes('Gas and fees are $0.05, above the limit of $0.01; waiting.'), list.out.includes('waiting for lower fees'), r.broadcasts], [true, true, []])
  })

  test('a scheduled run that cannot start is recorded with its reason', async (t) => {
    const dir = await home(t)
    await saveNightly(dir)
    await scheduleAt(dir, '2020-01-01T00:00:00Z')
    const r = await chainer(dir, standardWorld({ balances: {} }), ['daemon', '--once'])
    assert.match(r.out, /"nightly" did not run: The wallet holds 0 USDC on Arbitrum, not enough for this saved route/)
  })

  test('an unattended run never uses a restricted bridge that was not confirmed for its schedule', async (t) => {
    const dir = await home(t)
    await saveNightly(dir, standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'across', rate: 0.999 }] }))
    await chainer(dir, standardWorld(), ['schedule', 'add', 'nightly', '--at', '2020-01-01T00:00:00Z'], { input: 'no\n' })
    const r = await chainer(dir, standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'across', rate: 0.999 }] }), ['daemon', '--once'])
    assert.deepEqual([r.out.includes('Cancelled: the location confirmation was not given. Nothing was sent.'), r.broadcasts], [true, []])
  })
})
