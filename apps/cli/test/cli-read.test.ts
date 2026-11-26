// The real chainer command against a fake network: commands that only read.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { chainer, FRIEND, home, lastError, ME, standardWorld, TOKENS, ZERO } from './run.ts'

describe('reading commands', { concurrency: true }, () => {
  // ---- chains ----

  test('chains lists the main networks and the built-in coins, not test networks', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['chains'])
    const keys = r.out.split('\n').slice(1).filter(Boolean).map((l) => l.split(/\s+/)[0])
    assert.deepEqual(keys, ['eth', 'arb', 'bas', 'ltc', 'doge', 'dash', 'bch'])
  })

  test('chains --testnets adds the test networks, marked as such', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['chains', '--testnets'])
    assert.match(r.out, /^arbs\s+990012\s+Arbitrum Sepolia \(testnet\)\s+ETH$/m)
  })

  test('chains --json lists the chains with their ids', async (t) => {
    const chains = JSON.parse((await chainer(await home(t), standardWorld(), ['chains', '--json'])).out) as { key: string; id: number }[]
    assert.deepEqual(chains.find((c) => c.key === 'bas'), { ...chains.find((c) => c.key === 'bas'), id: 990003 })
  })

  test('the reading commands never ask anything the fake network does not know', async (t) => {
    const dir = await home(t)
    const runs = await Promise.all([['chains'], ['balances', 'arb'], ['quote', '1', 'USDC', 'arb', 'bas'], ['providers'], ['geo']].map((a) => chainer(dir, standardWorld(), a)))
    assert.deepEqual(runs.flatMap((r) => r.unexpected), [])
  })

  // ---- balances ----

  test('balances shows what the wallet holds, most valuable first, with the wallet and address', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['balances', 'arb'])
    assert.deepEqual(r.out.trim().split('\n'), [`main (${ME}) on Arbitrum`, 'TOKEN  BALANCE    VALUE     ADDRESS', `USDC   1000 USDC  $1000.00  ${TOKENS.usdcArb.address}`, `ETH    0.01 ETH   $30.00    ${ZERO}`])
  })

  test('balances on a chain where the wallet holds nothing says so', async (t) => {
    const r = await chainer(await home(t), standardWorld({ balances: {} }), ['balances', 'bas'])
    assert.equal(r.out.trim().split('\n').at(-1), 'No tokens found.')
  })

  test('balances --json gives each holding with its exact amount', async (t) => {
    const held = JSON.parse((await chainer(await home(t), standardWorld(), ['balances', 'arb', '--json'])).out) as { token: { symbol: string }; balance: string }[]
    assert.deepEqual(held.map((h) => [h.token.symbol, h.balance]), [['USDC', '1000000000'], ['ETH', '10000000000000000']])
  })

  test('balances without a chain says how to use it', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['balances'])
    assert.deepEqual([r.code, lastError(r.err)], [1, 'Error: Use: chainer balances <chain>'])
  })

  test('balances on a chain nobody knows points to the chain list', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['balances', 'atlantis'])).err), 'Error: Unknown chain "atlantis". Run "chainer chains" to list them.')
  })

  test('balances before any wallet exists says how to make one', async (t) => {
    const r = await chainer(await home(t, { wallet: false }), standardWorld(), ['balances', 'arb'])
    assert.equal(lastError(r.err), 'Error: No wallet yet. Create one with "chainer wallet init" or "chainer wallet import".')
  })

  test('balances of a wallet that does not exist names it', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['balances', 'arb', '--wallet', 'cold'])).err), 'Error: No wallet named "cold"')
  })

  // ---- providers and geo ----

  test('providers lists the built-in sources and how to add the optional one', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['providers'])
    assert.deepEqual(r.out.trim().split('\n'), ['Built in: lifi, cctp, thorchain, maya', 'atomiq: not installed, Atomiq trustless swaps between Bitcoin / Lightning and Solana is not offered; add it with "npm install --no-save @atomiqlabs/sdk @atomiqlabs/chain-solana @solana/web3.js"'])
  })

  test('providers --json says what is built in and what is optional', async (t) => {
    const p = JSON.parse((await chainer(await home(t), standardWorld(), ['providers', '--json'])).out)
    assert.deepEqual([p.builtIn, p.optional[0].provider, p.optional[0].installed], [['lifi', 'cctp', 'thorchain', 'maya'], 'atomiq', false])
  })

  test('geo lists each restricted bridge and marks the ones denied by default', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['geo'])
    assert.deepEqual([/^paxos\s.*denied$/m.test(r.out), /^across\s+Across\s+not in: .*[^d]$/m.test(r.out)], [true, true])
  })

  test('geo --json gives the restrictions by bridge key', async (t) => {
    const g = JSON.parse((await chainer(await home(t), standardWorld(), ['geo', '--json'])).out)
    assert.equal(g.across.name, 'Across')
  })

  // ---- quote ----

  test('quote ranks the routes with what arrives, the worst case, cost, net value and time', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['quote', '100', 'USDC', 'arb', 'bas'])
    // 100 x 0.999 = 99.9; worst case 99.5 % of that = 99.4005; net 99.9 - 0.05 gas = 99.85
    assert.deepEqual(r.out.trim().split('\n'), ['100 USDC on Arbitrum -> USDC on Base, ranked cheapest first', '', '#  VIA            YOU RECEIVE  AT WORST      GAS + FEES  NET VALUE  TIME', '1  lifi/stargate  99.9 USDC    99.4005 USDC  $0.05       $99.85     60 s'])
  })

  test('quote to another token names it', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arb', to: 'ETH@bas', tool: 'stargate', rate: 0.0003 }] })
    assert.match((await chainer(await home(t), world, ['quote', '100', 'USDC', 'arb', 'ETH', 'bas'])).out, /^100 USDC on Arbitrum -> ETH on Base/)
  })

  test('quote --json gives each route’s net value, time and legs without the raw step', async (t) => {
    const [route] = JSON.parse((await chainer(await home(t), standardWorld(), ['quote', '100', 'USDC', 'arb', 'bas', '--json'])).out)
    // 99.9 - 0.05 in floating point
    assert.deepEqual([route.netUsd, route.etaSeconds, route.legs[0].toAmount, 'raw' in route.legs[0]], [99.85000000000001, 60, '99900000', false])
  })

  test('quote --prefer fastest puts the quicker route first', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999, seconds: 600 }, { from: 'USDC@arb', to: 'USDC@bas', tool: 'hop', rate: 0.99, seconds: 30 }] })
    const r = await chainer(await home(t), world, ['quote', '100', 'USDC', 'arb', 'bas', '--prefer', 'fastest'])
    assert.match(r.out, /ranked fastest first[\s\S]*\n1 {2}lifi\/hop/)
  })

  test('a route through a geo-restricted bridge is marked and explained', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'across', rate: 0.999 }] })
    const r = await chainer(await home(t), world, ['quote', '100', 'USDC', 'arb', 'bas'])
    assert.deepEqual([/lifi\/across \[geo\]/.test(r.out), r.out.includes('[geo] = uses a service with geo restrictions (chainer geo); you must confirm your location before it is used.')], [true, true])
  })

  test('a route through a stop-over is listed leg by leg', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arb', to: 'USDC@eth', tool: 'stargate', rate: 0.999 }, { from: 'USDC@eth', to: 'LINK@eth', tool: '1inch', rate: 0.0666 }] })
    const r = await chainer(await home(t), world, ['quote', '100', 'USDC', 'arb', 'LINK', 'eth'])
    assert.match(r.out, /No direct connection; the best route has 2 legs:\n {2}1\. 100 USDC arb -> 99\.9 USDC eth via lifi\/stargate\n {2}2\. 99\.4005 USDC eth -> 6\.620073 LINK eth via lifi\/1inch/)
  })

  test('quote without any route says so and fails', async (t) => {
    const r = await chainer(await home(t), standardWorld({ routes: [] }), ['quote', '100', 'USDC', 'arb', 'bas'])
    assert.deepEqual([r.code, lastError(r.err)], [1, 'Error: No route found, also not through other chains.'])
  })

  test('quote when LI.FI rate-limits names the source and the wait', async (t) => {
    const r = await chainer(await home(t), standardWorld({ routesError: { status: 429, message: 'Too many requests' } }), ['quote', '100', 'USDC', 'arb', 'bas'])
    assert.equal(lastError(r.err), 'Error: No route found. lifi: li.quest is rate-limiting this connection; try again later')
  })

  test('quote of an amount that is not a number is refused', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['quote', 'lots', 'USDC', 'arb', 'bas'])).err), 'Error: "lots" is not a valid amount')
  })

  test('quote of zero is refused', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['quote', '0', 'USDC', 'arb', 'bas'])).err), 'Error: The amount must be greater than zero')
  })

  test('quote with too few arguments shows how to use it', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['quote', '100', 'USDC', 'arb'])).err), 'Error: Use: <amount> <token> <chain> [<to-token>] <to-chain>, e.g. 100 USDC arbitrum base')
  })

  test('quote of a token the chain does not have names it', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['quote', '1', 'DOGEFI', 'arb', 'bas'])).err), "Error: li.quest responded 404: Could not find token 'DOGEFI' on chain '990002'")
  })

  test('an unknown preference is refused', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['quote', '1', 'USDC', 'arb', 'bas', '--prefer', 'safest'])).err), 'Error: --prefer must be "cheapest" or "fastest"')
  })

  test('a hop limit above 5 is refused', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['quote', '1', 'USDC', 'arb', 'bas', '--max-hops', '6'])).err), 'Error: --max-hops must be a whole number from 1 to 5')
  })

  test('a transfer worth more than the limit is refused before any route search', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['config', 'set', 'maxUsdPerTransfer', '50'])
    const r = await chainer(dir, standardWorld(), ['quote', '100', 'USDC', 'arb', 'bas'])
    assert.deepEqual([lastError(r.err), r.requests.some((q) => q.includes('advanced/routes'))], ['Error: This transfer is worth about $100.00, above your limit of $50.00 (chainer config set maxUsdPerTransfer <usd|off>)', false])
  })

  test('a recipient that is not an address on the destination is refused', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['quote', '1', 'USDC', 'arb', 'bas', '--to', 'nobody'])).err), 'Error: "nobody" is not a valid address on Base')
  })

  test('the quote is for the recipient given with --to', async (t) => {
    const r = await chainer(await home(t), standardWorld(), ['quote', '1', 'USDC', 'arb', 'bas', '--to', FRIEND, '--json'])
    assert.equal(JSON.parse(r.out)[0].legs[0].request.toAddress, FRIEND)
  })

  // ---- test networks ----

  test('with --testnet a main network is replaced by its test network', async (t) => {
    const world = standardWorld({ routes: [{ from: 'USDC@arbs', to: 'USDC@bast', tool: 'stargate', rate: 0.999 }], balances: {} })
    assert.match((await chainer(await home(t), world, ['quote', '1', 'USDC', 'arb', 'bas', '--testnet'])).out, /^1 USDC on Arbitrum Sepolia -> USDC on Base Sepolia/)
  })

  test('with --testnet a chain without a test network is refused with what to do instead', async (t) => {
    assert.equal(lastError((await chainer(await home(t), standardWorld(), ['quote', '1', 'LTC', 'ltc', 'bas', '--testnet'])).err), 'Error: Litecoin has no test network here, so this route cannot be tested with test funds. Use --dry-run to check it without sending.')
  })

  test('with --testnet no limit on the transfer’s value applies', async (t) => {
    const dir = await home(t)
    await chainer(dir, standardWorld(), ['config', 'set', 'maxUsdPerTransfer', '1'])
    const world = standardWorld({ routes: [{ from: 'USDC@arbs', to: 'USDC@bast', tool: 'stargate', rate: 0.999 }] })
    assert.equal((await chainer(dir, world, ['quote', '100', 'USDC', 'arb', 'bas', '--testnet'])).code, 0)
  })
})
