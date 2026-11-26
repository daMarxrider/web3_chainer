// The real chainer command against a fake network: sending, following runs, and the settings
// that need the chain list. The fake network signs nothing itself; it records what the program broadcast.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { decodeFunctionData, erc20Abi } from 'viem'
import { chainer, DIAMOND, FRIEND, home, lastError, ME, standardWorld, TOKENS, ZERO } from './run.ts'

const send100 = ['send', '100', 'USDC', 'arb', 'bas']
const runIdOf = (out: string) => /^Run ([0-9a-f]{8})$/m.exec(out)?.[1]

describe('sending and following runs', { concurrency: true }, () => {
  // ---- send ----

  test('a dry run shows the route and recipient and sends nothing', async (t) => {
    const r = await chainer(await home(t), standardWorld(), [...send100, '--dry-run'])
    assert.deepEqual([r.out.includes('Route:     lifi/stargate'), r.out.includes(`Recipient: ${ME}`), r.out.trim().split('\n').at(-1), r.broadcasts], [true, true, 'Dry run: nothing was signed or sent.', []])
  })

  test('sending more than the wallet holds is refused before any route search', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['send', '2000', 'USDC', 'arb', 'bas'])
    assert.deepEqual([r.code, lastError(r.err), r.requests.some((q) => q.includes('advanced/routes'))], [1, 'Error: Not enough USDC on Arbitrum: the wallet holds 1000 USDC', false])
  })

  test('a dry run of more than the wallet holds only notes it and still shows the route', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['send', '2000', 'USDC', 'arb', 'bas', '--dry-run'])
    assert.deepEqual([r.err.includes('Note: Not enough USDC on Arbitrum: the wallet holds 1000 USDC'), r.code], [true, 0])
  })

  test('declining the confirmation sends nothing', async (t) => {
    const r = await chainer(await home(t), standardWorld(), send100, { input: 'n\n' })
    assert.deepEqual([r.out.trim().split('\n').at(-1), r.broadcasts], ['Cancelled.', []])
  })

  test('a confirmed transfer approves the bridge for exactly the amount, then sends to it, signed by the wallet', async (t) => {
    const r = await chainer(await home(t), standardWorld(), send100, { input: 'y\n' })
    const [approve, main] = r.broadcasts
    const approval = decodeFunctionData({ abi: erc20Abi, data: approve!.data! }).args as readonly [string, bigint]
    assert.deepEqual([approve!.from, approve!.to, approval[0], approval[1], main!.from, main!.to, r.broadcasts.length], [ME, TOKENS.usdcArb.address.toLowerCase(), DIAMOND, 100_000_000n, ME, DIAMOND.toLowerCase(), 2])
  })

  test('a confirmed transfer ends with what arrived and where', async (t) => {
    const r = await chainer(await home(t), standardWorld(), send100, { input: 'y\n' })
    assert.equal(r.out.trim().split('\n').at(-1), `Done. Received 99.9 USDC at ${ME}`)
  })

  test('the amount LI.FI reports as received is the one shown', async (t) => {
    const r = await chainer(await home(t), standardWorld({ received: '99950000' }), send100, { input: 'y\n' })
    assert.equal(r.out.trim().split('\n').at(-1), `Done. Received 99.95 USDC at ${ME}`)
  })

  test('--yes sends without asking', async (t) => {
    const r = await chainer(await home(t), standardWorld(), [...send100, '--yes'])
    assert.equal(r.broadcasts.length, 2)
  })

  test('with enough allowance already, no approval is sent', async (t) => {
    const r = await chainer(await home(t), standardWorld({ allowance: '100000000' }), [...send100, '--yes'])
    assert.deepEqual(r.broadcasts.map((b) => b.to), [DIAMOND.toLowerCase()])
  })

  test('sending the chain’s coin needs no approval and carries the amount as value', async (t) => {
    const world = standardWorld({ routes: [{ from: 'ETH@eth', to: 'ETH@bas', tool: 'stargate', rate: 0.999 }] })
    const r = await chainer(await home(t), world, ['send', '0.5', 'ETH', 'eth', 'bas', '--yes'])
    assert.deepEqual(r.broadcasts.map((b) => [b.to, b.value]), [[DIAMOND.toLowerCase(), 500_000_000_000_000_000n]])
  })

  test('a transfer to a recipient goes to that recipient', async (t) => {
    const r = await chainer(await home(t), standardWorld(), [...send100, '--to', FRIEND, '--yes'])
    assert.equal(r.out.trim().split('\n').at(-1), `Done. Received 99.9 USDC at ${FRIEND}`)
  })

  test('a reverted transaction stops the run, fails the command and says how to resume', async (t) => {
    const r = await chainer(await home(t), standardWorld({ receipt: 'reverted' }), [...send100, '--yes'])
    const id = runIdOf(r.out)
    assert.deepEqual([r.code, r.out.trim().split('\n').slice(-2)], [1, ['Stopped at leg 1.', `After fixing the cause, continue with "chainer resume ${id}".`]])
  })

  test('a bridge that reports failure stops the run', async (t) => {
    const r = await chainer(await home(t), standardWorld({ status: 'FAILED' }), [...send100, '--yes'])
    assert.deepEqual([r.code, r.out.includes('Stopped at leg 1.')], [1, true])
  })

  test('--json prints progress as JSON lines and the run as JSON', async (t) => {
    const r = await chainer(await home(t), standardWorld(), [...send100, '--yes', '--json'])
    const lines = r.err.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
    assert.deepEqual([lines[0].leg, typeof lines[0].message, JSON.parse(r.out.slice(r.out.indexOf('{'))).state], [1, 'string', 'done'])
  })

  test('with --json nothing but the run’s JSON is printed on stdout', async (t) => {
    const r = await chainer(await home(t), standardWorld(), [...send100, '--yes', '--json'])
    assert.equal(JSON.parse(r.out).state, 'done')
  })

  test('progress is printed as plain lines when not on a terminal', async (t) => {
    const r = await chainer(await home(t), standardWorld(), [...send100, '--yes'])
    assert.match(r.out, /^\[\d\d:\d\d:\d\d\] leg 1\/1: Signing and sending the transaction$/m)
  })

  // ---- geo restrictions ----

  const across = () => standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'across', rate: 0.999 }] })

  test('a restricted bridge asks for the location after the confirmation, and "yes" sends', async (t) => {
    const r = await chainer(await home(t), across(), send100, { input: 'y\nyes\n' })
    assert.deepEqual([r.err.includes('!! GEO-RESTRICTED SERVICES !!'), r.err.includes('Across - not available in'), r.broadcasts.length], [true, true, 2])
  })

  test('a restricted bridge without "yes" sends nothing', async (t) => {
    const r = await chainer(await home(t), across(), send100, { input: 'y\nno\n' })
    assert.deepEqual([r.out.trim().split('\n').at(-1), r.broadcasts], ['Cancelled: the location confirmation was not given. Nothing was sent.', []])
  })

  test('--yes never answers the location form', async (t) => {
    const r = await chainer(await home(t), across(), [...send100, '--yes'], { input: '\n' })
    assert.deepEqual([r.out.trim().split('\n').at(-1), r.broadcasts], ['Cancelled: the location confirmation was not given. Nothing was sent.', []])
  })

  test('on test networks the location form is not shown', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arbs', to: 'USDC@bast', tool: 'across', rate: 0.999 }], balances: { [ME]: { [`arbs:${TOKENS.usdcArbs.address}`]: '1000000000', [`bast:${ZERO}`]: '1' } } })
    const r = await chainer(await home(t), world, [...send100, '--testnet', '--yes'])
    assert.deepEqual([r.err.includes('GEO-RESTRICTED'), r.broadcasts.length], [false, 2])
  })

  // ---- gas top-up and stop-over gas ----

  /** USDC to Base where the wallet has no ETH; a USDC -> ETH route on Base lets a top-up be routed. */
  const noGasOnBase = () =>
    standardWorld({
      balances: { [ME]: { [`arb:${TOKENS.usdcArb.address}`]: '1000000000', [`arb:${ZERO}`]: '10000000000000000' } },
      routes: [
        { from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 },
        { from: 'USDC@arb', to: 'ETH@bas', tool: 'stargate', rate: 0.000333 },
      ],
    })

  test('a recipient without gas on the destination gets a top-up, shown before sending', async (t) => {
    // 1 gwei x 150 000 gas = 0.00015 ETH = $0.45, twice = $0.90 = 0.9 USDC
    const r = await chainer(await home(t), noGasOnBase(), [...send100, '--dry-run'])
    assert.match(r.out, /^Extra: {5}0\.9 USDC for gas as ETH on Base \(the recipient has none\), via lifi\/stargate$/m)
  })

  test('a top-up is sent after the main transfer', async (t) => {
    const r = await chainer(await home(t), noGasOnBase(), [...send100, '--yes'])
    assert.deepEqual([r.out.includes('Gas top-up: 0.9 USDC -> ETH on bas'), r.broadcasts.filter((b) => b.to === DIAMOND.toLowerCase()).length], [true, 2])
  })

  test('--gas-topup off sends no top-up', async (t) => {
    const r = await chainer(await home(t), noGasOnBase(), [...send100, '--dry-run', '--gas-topup', 'off'])
    assert.equal(r.out.includes('Extra:'), false)
  })

  test('a fixed top-up is used as given', async (t) => {
    const r = await chainer(await home(t), noGasOnBase(), [...send100, '--dry-run', '--gas-topup', '$3'])
    assert.match(r.out, /^Extra: {5}3 USDC for gas/m)
  })

  test('a top-up without a route says so and the transfer still goes ahead', async (t) => {
    const world = { ...noGasOnBase(), routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999 }] }
    const r = await chainer(await home(t), world, [...send100, '--dry-run'])
    assert.match(r.out, /^No gas top-up: no route for it \(No route found, also not through other chains\.\)\.$/m)
  })

  test('a recipient that already has gas gets no top-up, and is told why', async (t) => {
    const r = await chainer(await home(t), standardWorld(), [...send100, '--dry-run'])
    assert.deepEqual([r.out.includes('Extra:'), /^No gas top-up: the recipient already has gas on the destination\.$/m.test(r.out)], [false, true])
  })

  test('a route that stops on a chain without gas sends gas there first', async (t) => {
    // USDC arb -> USDC eth (stop-over: no ETH on eth at that address) -> LINK eth; gas ahead = 2 x the next leg's $0.10 cost.
    const world = standardWorld({
      balances: { [ME]: { [`arb:${TOKENS.usdcArb.address}`]: '1000000000' } },
      routes: [
        { from: 'USDC@arb', to: 'USDC@eth', tool: 'stargate', rate: 0.999 },
        { from: 'USDC@eth', to: 'LINK@eth', tool: '1inch', rate: 0.0666 },
        { from: 'USDC@arb', to: 'ETH@eth', tool: 'stargate', rate: 0.000333 },
      ],
    })
    const r = await chainer(await home(t), world, ['send', '100', 'USDC', 'arb', 'LINK', 'eth', '--dry-run', '--gas-topup', 'off'])
    const withGas = await chainer(await home(t), world, ['send', '100', 'USDC', 'arb', 'LINK', 'eth', '--dry-run'])
    assert.deepEqual([r.out.includes('Gas ahead'), /^Gas ahead: about \$0\.20 of USDC -> ETH on eth \(needed for the next leg\), via lifi\/stargate$/m.test(withGas.out)], [false, true])
  })

  // ---- status and resume ----

  test('status before any run says there are none', async (t) => {
    assert.equal((await chainer(await home(t), standardWorld(), ['status'])).out.trim(), 'No runs yet.')
  })

  test('status lists a finished run with its legs and transfer', async (t) => {
    const dir = await home(t)
    const sent = await chainer(dir, standardWorld(), [...send100, '--yes'])
    const r = await chainer(dir, standardWorld(), ['status'])
    assert.match(r.out, new RegExp(`^${runIdOf(sent.out)}\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\s+done\\s+1/1\\s+100 USDC arb -> USDC bas$`, 'm'))
  })

  test('status with an id shows the run leg by leg', async (t) => {
    const dir = await home(t)
    const id = runIdOf((await chainer(dir, standardWorld(), [...send100, '--yes'])).out)!
    const r = await chainer(dir, standardWorld(), ['status', id])
    assert.match(r.out, /^✔ 1\. 100 USDC arb -> USDC bas via lifi\/stargate: received 99\.9 USDC$/m)
  })

  test('status --json lists the runs as JSON', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), [...send100, '--yes'])
    assert.equal(JSON.parse((await chainer(dir, standardWorld(), ['status', '--json'])).out)[0].state, 'done')
  })

  test('status of an id no run has says so and mentions test runs', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['status', 'abcdef'])).err), 'Error: No run with id "abcdef" (add --testnet for test runs)')
  })

  test('test runs are kept apart from real ones', async (t) => {
    const dir = await home(t)
    const world = standardWorld({ routes: [{ from: 'USDC@arbs', to: 'USDC@bast', tool: 'stargate', rate: 0.999 }], balances: { [ME]: { [`arbs:${TOKENS.usdcArbs.address}`]: '1000000000', [`bast:${ZERO}`]: '1' } } })
    await chainer(dir, world, [...send100, '--testnet', '--yes'])
    assert.deepEqual([(await chainer(dir, world, ['status'])).out.trim(), (await chainer(dir, world, ['status', '--testnet', '--json'])).out.includes('"done"')], ['No runs yet.', true])
  })

  test('resume without an id says what to give', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['resume'])).err), 'Error: Give the id of a run (see "chainer status")')
  })

  test('resuming a finished run only shows it', async (t) => {
    const dir = await home(t)
    const id = runIdOf((await chainer(dir, standardWorld(), [...send100, '--yes'])).out)!
    const r = await chainer(dir, standardWorld(), ['resume', id])
    assert.deepEqual([r.out.startsWith(`Run ${id}`), r.broadcasts], [true, []])
  })

  test('a run stopped by a revert is finished by resume once the chain accepts it', async (t) => {
    const dir = await home(t)
    const id = runIdOf((await chainer(dir, standardWorld({ receipt: 'reverted' }), [...send100, '--yes'])).out)!
    const r = await chainer(dir, standardWorld(), ['resume', id])
    assert.equal(r.out.trim().split('\n').at(-1), `Done. Received 99.9 USDC at ${ME}`)
  })

  test('resuming a run with a restricted bridge asks for the location again, and without it leaves that bridge out', async (t) => {
    const dir = await home(t)
    const stopped = await chainer(dir, { ...across(), receipt: 'reverted' }, [...send100, '--yes'], { input: 'yes\n' })
    const r = await chainer(dir, across(), ['resume', runIdOf(stopped.out)!], { input: 'no\n' })
    assert.deepEqual([r.err.includes('This run was started with a confirmation for:'), r.out.includes('Without the confirmation these bridges are left out; the remaining legs use the others.')], [true, true])
  })

  // ---- address book, RPC overrides, wallet refresh ----

  test('an address saved in the book can be the recipient', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['book', 'add', 'friend', 'bas', FRIEND])
    const r = await chainer(dir, standardWorld(), [...send100, '--to', 'friend', '--yes'])
    assert.equal(r.out.trim().split('\n').at(-1), `Done. Received 99.9 USDC at ${FRIEND}`)
  })

  test('the address book lists what was saved', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['book', 'add', 'friend', 'bas', FRIEND])
    assert.deepEqual((await chainer(dir, standardWorld(), ['book'])).out.trim().split('\n'), ['LABEL   CHAIN  ADDRESS', `friend  bas    ${FRIEND}`])
  })

  test('an empty address book says how to add to it', async (t) => {
    assert.equal((await chainer(await home(t), standardWorld(), ['book', 'list'])).out.trim(), 'The address book is empty. Add one with "chainer book add <label> <chain> <address>".')
  })

  test('the address book --json lists the entries', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['book', 'add', 'friend', 'bas', FRIEND])
    assert.deepEqual(JSON.parse((await chainer(dir, standardWorld(), ['book', '--json'])).out), [{ label: 'friend', chainKey: 'bas', address: FRIEND }])
  })

  test('an address that is not valid on the chain is not saved', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['book', 'add', 'friend', 'bas', 'nope'])).err), 'Error: "nope" is not a valid address on bas')
  })

  test('a book entry is removed on the chain named', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['book', 'add', 'friend', 'bas', FRIEND])
    assert.equal((await chainer(dir, standardWorld(), ['book', 'remove', 'friend', 'bas'])).out.trim(), 'Removed "friend" on Base.')
  })

  test('a book entry is removed on every chain without a chain named', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['book', 'add', 'friend', 'bas', FRIEND])
    assert.equal((await chainer(dir, standardWorld(), ['book', 'remove', 'friend'])).out.trim(), 'Removed "friend".')
  })

  test('an unknown book subcommand shows how to use it', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['book', 'burn'])).err), 'Error: Use: chainer book list | add <label> <chain> <address> | remove <label> [<chain>]')
  })

  test('an RPC override is saved for the chain', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['config', 'rpc', 'arb', 'https://my.node'])
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).rpc, { arb: 'https://my.node' })
  })

  test('an RPC override is removed with "default"', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['config', 'rpc', 'arb', 'https://my.node'])
    await chainer(dir, standardWorld(), ['config', 'rpc', 'arb', 'default'])
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).rpc, {})
  })

  test('an RPC override that is not a web address is refused', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['config', 'rpc', 'arb', 'my.node'])).err), 'Error: Give an http(s) URL, or "default" to remove the override')
  })

  test('an RPC override is used for the chain', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['config', 'rpc', 'arb', 'https://rpc-arb.fake/mine'])
    const r = await chainer(dir, standardWorld(), ['balances', 'arb'])
    assert.equal(r.requests.some((q) => q.startsWith('rpc-arb.fake')), true)
  })

  test('wallet refresh lists the addresses the wallet now has', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['wallet', 'refresh'])
    assert.match(r.out, new RegExp(`^Wallet "main" now lists: evm ${ME}, sol `))
  })

  test('a gas top-up setting that is not understood is refused', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), [...send100, '--dry-run', '--gas-topup', 'lots'])).err), 'Error: "lots" is not a gas top-up setting; use off, a multiplier like 2x, or a fixed value like $3')
  })

  test('the signed transactions carry the source chain’s id', async (t) => {
    const r = await chainer(await home(t), standardWorld(), [...send100, '--yes'])
    assert.deepEqual(r.broadcasts.map((b) => b.chainId), [990002, 990002])
  })
})
