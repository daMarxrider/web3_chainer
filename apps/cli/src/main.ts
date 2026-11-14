import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { parse as parseYaml } from 'yaml'
import {
  addAccount,
  evmAdapter,
  findAccount,
  findChain,
  findPipelineRoutes,
  findRoutes,
  formatUnits,
  lifiChains,
  lifiProvider,
  lifiToken,
  lifiTokens,
  listPipelines,
  loadKeystore,
  loadSettings,
  newMnemonic,
  newPipeline,
  parseUnits,
  pipelineFromRoute,
  routeEta,
  routeNetUsd,
  runPipeline,
  saveSettings,
  unlock,
  type Chain,
  type PipelineLeg,
  type PipelineRecord,
  type Prefer,
  type QuoteRequest,
  type Route,
  type Settings,
  type Store,
  type Token,
} from '@chainer/core'
import { dataDir, fetchWithTimeout as fetchFn, fileStore } from './env.ts'
import { askHidden, askPassword, confirm } from './prompt.ts'

const HELP = `chainer - move tokens between blockchains over the best route

Usage:
  chainer wallet init [--name <name>]         Create a wallet with a new seed phrase
  chainer wallet import [--name <name>]       Import a seed phrase or private key
  chainer wallet list                         Show wallets and their addresses
  chainer chains [--testnets]                 List supported chains
  chainer balances <chain>                    Show the wallet's tokens on a chain
  chainer quote <amount> <token> <chain> [<to-token>] <to-chain>
                                              Compare routes without sending anything
  chainer send  <amount> <token> <chain> [<to-token>] <to-chain>
                                              Send over the best route and follow it live
  chainer pipeline run <plan.yaml>            Run a chain of transfers, each starting when
                                              the previous one has arrived
  chainer status [<id>]                       List runs, or show one in detail
  chainer resume <id>                         Continue a run that stopped or failed
  chainer config show
  chainer config set <prefer|slippage|maxUsdPerTransfer|maxHops> <value>
  chainer config rpc <chain> <url|default>    Use your own RPC node for a chain
  chainer config avoid <add|remove> <token>   Tokens never to route through or into

Options:
  --wallet <name>            Wallet to use (default: the first one)
  --prefer cheapest|fastest  Ranking for this run (default: from config)
  --max-hops <n>             Most legs an automatic route may have (default: from config)
  --to <address>             Recipient (default: your own address)
  --testnet                  Run on the test networks of the named chains, with test funds
  --dry-run                  Stop before signing
  --yes                      Do not ask for confirmation
  --json                     Machine-readable output

Plan file:
  wallet: main                 # optional
  legs:
    - amount: 100              # a number, or "all" (whole balance / what the last leg delivered)
      from: USDC@arbitrum
      to: USDC@base
    - amount: all
      from: USDC@base
      to: ETH@optimism

No warranty: this software is provided as is. You alone are responsible for any loss of
funds, whether from bugs or from how you use it. See the README and LICENSE.

Environment:
  CHAINER_PASSWORD   Wallet password, for unattended use
  CHAINER_HOME       Data folder (default: ${dataDir()})
`

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wallet: { type: 'string' },
    name: { type: 'string' },
    prefer: { type: 'string' },
    'max-hops': { type: 'string' },
    to: { type: 'string' },
    testnet: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' },
    json: { type: 'boolean' },
    testnets: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

const store = fileStore(dataDir())
const settings = await loadSettings(store)

/** Runs on test networks are journalled apart from real ones; the wallet is shared. */
const runStore: Store = opts.testnet
  ? { get: (k) => store.get(`testnet/${k}`), set: (k, v) => store.set(`testnet/${k}`, v), keys: async (p) => (await store.keys(`testnet/${p}`)).map((k) => k.slice('testnet/'.length)) }
  : store

const out = (line = '') => console.log(line)
const printJson = (value: unknown) => out(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
const usd = (n: number | undefined) => (n === undefined ? '?' : `$${n.toFixed(2)}`)
const stamp = () => new Date().toTimeString().slice(0, 8)
/** Journal times are stored in UTC; show them in the user's time zone. */
const localTime = (iso: string) => new Date(iso).toLocaleString('sv').slice(0, 16)

function fmt(amount: bigint | string, token: Token): string {
  const [whole, frac = ''] = formatUnits(BigInt(amount), token.decimals).split('.')
  const trimmed = frac.slice(0, 6).replace(/0+$/, '')
  return `${whole}${trimmed ? `.${trimmed}` : ''} ${token.symbol}`
}

function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

function table(rows: string[][]): void {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  for (const row of rows) out(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd())
}

function preference(): Prefer {
  const p = opts.prefer ?? settings.prefer
  if (p !== 'cheapest' && p !== 'fastest') throw new Error('--prefer must be "cheapest" or "fastest"')
  return p
}

function maxHops(): number {
  const n = opts['max-hops'] === undefined ? settings.maxHops : Number(opts['max-hops'])
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error('--max-hops must be a whole number from 1 to 5')
  return n
}

// ---- chains, tokens, providers ------------------------------------------

/** Test network standing in for each main network in --testnet mode. */
const TESTNET_OF: Record<string, string> = { eth: 'eths', opt: 'opst', arb: 'arbs', bas: 'bast' }
/** Liquid tokens tried as stop-overs when two chains have no direct connection. */
const HUBS: [chain: string, token: string][] = [
  ['eth', 'USDC'],
  ['eth', 'ETH'],
  ['arb', 'USDC'],
  ['arb', 'ETH'],
  ['bas', 'USDC'],
  ['bas', 'ETH'],
]

let chainList: Promise<Chain[]> | undefined
const allChains = () => (chainList ??= lifiChains(fetchFn))
const adapterFor = (chain: Chain) => evmAdapter(chain, { fetch: fetchFn, rpcUrl: settings.rpc[chain.key] })

async function resolveChain(query: string): Promise<Chain> {
  const chains = await allChains()
  const chain = findChain(chains, query)
  if (!opts.testnet || chain.testnet) return chain
  const testnet = chains.find((c) => c.key === TESTNET_OF[chain.key])
  if (!testnet) throw new Error(`${chain.name} has no test network here, so this route cannot be tested with test funds. Use --dry-run to check it without sending.`)
  return testnet
}

async function resolveToken(spec: string): Promise<Token> {
  const [symbol, chainQuery] = spec.split('@')
  if (!symbol || !chainQuery) throw new Error(`"${spec}" should look like TOKEN@chain, e.g. USDC@arbitrum`)
  return lifiToken(fetchFn, await resolveChain(chainQuery), symbol)
}

async function hubTokens(): Promise<Token[]> {
  const found = await Promise.allSettled(HUBS.map(([chain, token]) => resolveToken(`${token}@${chain}`)))
  return found.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
}

async function runDeps() {
  const chains = await allChains()
  const byKey = (key: string) => {
    const chain = chains.find((c) => c.key === key)
    if (!chain) throw new Error(`Chain "${key}" is no longer listed`)
    return chain
  }
  return { providers: [lifiProvider(fetchFn, chains, settings)], adapterFor: (key: string) => adapterFor(byKey(key)), chainName: (key: string) => byKey(key).name }
}

// ---- wallet -------------------------------------------------------------

async function walletCommand(sub: string | undefined): Promise<void> {
  const keystore = await loadKeystore(store)
  if (sub === 'list') {
    if (opts.json) return printJson(keystore.accounts.map(({ name, type, addresses }) => ({ name, type, addresses })))
    if (keystore.accounts.length === 0) return out('No wallets yet. Create one with "chainer wallet init".')
    return table([['NAME', 'TYPE', 'EVM ADDRESS'], ...keystore.accounts.map((a) => [a.name, a.type, a.addresses.evm])])
  }
  if (sub !== 'init' && sub !== 'import') throw new Error('Use: chainer wallet init | import | list')

  const name = opts.name ?? (keystore.accounts.length === 0 ? 'main' : `wallet${keystore.accounts.length + 1}`)
  const secret = sub === 'init' ? newMnemonic() : await askHidden('Seed phrase or private key (input hidden): ')
  const password = await askPassword(keystore.accounts.length === 0 ? 'Choose a wallet password (min. 8 characters): ' : 'Wallet password: ')
  if (keystore.accounts.length === 0 && !process.env.CHAINER_PASSWORD && (await askHidden('Repeat the password: ')) !== password) {
    throw new Error('The passwords do not match')
  }
  const record = await addAccount(store, name, secret, password)
  out(`Wallet "${record.name}" saved. EVM address: ${record.addresses.evm}`)
  if (sub === 'init') {
    out()
    out('Write this seed phrase down and keep it offline. It is the only backup and is not shown again:')
    out()
    out(`  ${secret}`)
  }
}

// ---- chains and balances ------------------------------------------------

async function chainsCommand(): Promise<void> {
  const chains = (await allChains()).filter((c) => opts.testnets || !c.testnet)
  if (opts.json) return printJson(chains)
  table([['KEY', 'ID', 'NAME', 'COIN'], ...chains.map((c) => [c.key, String(c.id), c.name + (c.testnet ? ' (testnet)' : ''), c.nativeSymbol])])
}

async function balancesCommand(chainQuery: string | undefined): Promise<void> {
  if (!chainQuery) throw new Error('Use: chainer balances <chain>')
  const account = findAccount(await loadKeystore(store), opts.wallet)
  const chain = await resolveChain(chainQuery)
  const tokens = await lifiTokens(fetchFn, chain)
  const balances = await adapterFor(chain).getBalances(account.addresses.evm, tokens)
  const held = tokens
    .map((token, i) => ({ token, balance: balances[i]!, usd: token.priceUsd === undefined ? undefined : (Number(balances[i]!) / 10 ** token.decimals) * token.priceUsd }))
    .filter((h) => h.balance > 0n)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
  if (opts.json) return printJson(held)
  out(`${account.name} (${account.addresses.evm}) on ${chain.name}`)
  if (held.length === 0) return out('No tokens found.')
  table([['TOKEN', 'BALANCE', 'VALUE', 'ADDRESS'], ...held.map((h) => [h.token.symbol, fmt(h.balance, h.token), usd(h.usd), h.token.address])])
}

// ---- quote and send -----------------------------------------------------

interface Plan {
  request: QuoteRequest
  fromChain: Chain
  toChain: Chain
  wallet: string
}

function checkLimit(amount: bigint, token: Token): void {
  const valueUsd = token.priceUsd === undefined ? undefined : (Number(amount) / 10 ** token.decimals) * token.priceUsd
  if (!opts.testnet && settings.maxUsdPerTransfer !== null && valueUsd !== undefined && valueUsd > settings.maxUsdPerTransfer) {
    throw new Error(`This transfer is worth about ${usd(valueUsd)}, above your limit of ${usd(settings.maxUsdPerTransfer)} (chainer config set maxUsdPerTransfer <usd|off>)`)
  }
}

function parseAmount(text: string, token: Token): bigint {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`"${text}" is not a valid amount`)
  const amount = parseUnits(text, token.decimals)
  if (amount === 0n) throw new Error('The amount must be greater than zero')
  return amount
}

async function buildPlan(args: string[]): Promise<Plan> {
  if (args.length !== 4 && args.length !== 5) throw new Error('Use: <amount> <token> <chain> [<to-token>] <to-chain>, e.g. 100 USDC arbitrum base')
  const [amountText, fromSymbol, fromChainQuery] = args as [string, string, string]
  const toSymbol = args.length === 5 ? args[3]! : fromSymbol

  const account = findAccount(await loadKeystore(store), opts.wallet)
  const [fromChain, toChain] = await Promise.all([resolveChain(fromChainQuery), resolveChain(args.at(-1)!)])
  const [from, to] = await Promise.all([lifiToken(fetchFn, fromChain, fromSymbol), lifiToken(fetchFn, toChain, toSymbol)])
  const amount = parseAmount(amountText, from)
  const toAddress = opts.to ?? account.addresses.evm
  if (!adapterFor(toChain).validateAddress(toAddress)) throw new Error(`"${toAddress}" is not a valid address on ${toChain.name}`)
  checkLimit(amount, from)
  return { request: { from, to, amount, fromAddress: account.addresses.evm, toAddress, slippage: settings.slippage }, fromChain, toChain, wallet: account.name }
}

async function search(plan: Plan): Promise<Route[]> {
  const { providers } = await runDeps()
  const { routes, errors } = await findPipelineRoutes(plan.request, providers, settings, { prefer: preference(), hubs: hubTokens, maxHops: maxHops() })
  if (routes.length === 0) throw new Error(errors.length ? `No route found. ${errors.join('; ')}` : 'No route found, also not through other chains.')
  for (const e of errors) console.error(`Note: ${e}`)
  return routes
}

const routeVia = (route: Route) => route.legs.map((q) => `${q.provider}/${q.tool}`).join(' > ')

function printRoutes(plan: Plan, routes: Route[]): void {
  const { from, to, amount } = plan.request
  out(`${fmt(amount, from)} on ${plan.fromChain.name} -> ${to.symbol} on ${plan.toChain.name}, ranked ${preference()} first`)
  out()
  table([
    ['#', 'VIA', 'YOU RECEIVE', 'AT WORST', 'GAS + FEES', 'NET VALUE', 'TIME'],
    ...routes.slice(0, 8).map((r, i) => {
      const last = r.legs.at(-1)!
      return [String(i + 1), routeVia(r), fmt(last.toAmount, to), fmt(last.toAmountMin, to), usd(r.legs.reduce((s, q) => s + q.costUsd, 0)), usd(routeNetUsd(r)), duration(routeEta(r))]
    }),
  ])
  const best = routes[0]!
  if (best.legs.length > 1) {
    out()
    out(`No direct connection; the best route has ${best.legs.length} legs:`)
    best.legs.forEach((q, i) => out(`  ${i + 1}. ${fmt(q.request.amount, q.request.from)} ${q.request.from.chainKey} -> ${fmt(q.toAmount, q.request.to)} ${q.request.to.chainKey} via ${q.provider}/${q.tool}`))
  }
}

async function quoteCommand(args: string[]): Promise<void> {
  const plan = await buildPlan(args)
  const routes = await search(plan)
  if (opts.json) return printJson(routes.map((r) => ({ netUsd: routeNetUsd(r), etaSeconds: routeEta(r), legs: r.legs.map(({ raw: _, ...q }) => q) })))
  printRoutes(plan, routes)
}

async function sendCommand(args: string[]): Promise<void> {
  const plan = await buildPlan(args)
  const { request } = plan
  const [balance] = await adapterFor(plan.fromChain).getBalances(request.fromAddress, [request.from])
  if (balance! < request.amount) {
    const problem = `Not enough ${request.from.symbol} on ${plan.fromChain.name}: the wallet holds ${fmt(balance!, request.from)}`
    if (!opts['dry-run']) throw new Error(problem)
    console.error(`Note: ${problem}`)
  }

  const routes = await search(plan)
  if (!opts.json) {
    printRoutes(plan, routes)
    out()
    out(`Route:     ${routeVia(routes[0]!)}`)
    out(`Recipient: ${request.toAddress}`)
  }
  if (opts['dry-run']) return out('Dry run: nothing was signed or sent.')
  if (!opts.yes && !(await confirm(`Send ${fmt(request.amount, request.from)} over this route?`))) return out('Cancelled.')
  await execute(pipelineFromRoute(routes[0]!, plan.wallet))
}

// ---- pipelines ----------------------------------------------------------

const MARK = { waiting: '·', running: '▶', done: '✔', failed: '✘' }

function legText(leg: PipelineLeg): string {
  const amount = leg.amount === 'all' ? `all ${leg.from.symbol}` : fmt(leg.amount, leg.from)
  const tail = leg.state === 'done' && leg.received ? `: received ${fmt(leg.received, leg.to)}` : leg.state === 'failed' ? `: ${leg.error}` : ''
  return `${amount} ${leg.from.chainKey} -> ${leg.to.symbol} ${leg.to.chainKey}${leg.via ? ` via ${leg.via}` : ''}${tail}`
}

/** Live status: a leg list redrawn in place on a terminal, plain lines when piped, JSON lines with --json. */
function liveView(): (record: PipelineRecord, legIndex: number, message: string) => void {
  let drawn = 0
  return (record, legIndex, message) => {
    if (opts.json) return console.error(JSON.stringify({ id: record.id, leg: legIndex + 1, state: record.legs[legIndex]!.state, message }))
    if (!process.stdout.isTTY) return out(`[${stamp()}] leg ${legIndex + 1}/${record.legs.length}: ${message}`)
    const width = (process.stdout.columns ?? 100) - 1
    const lines = record.legs.map((leg, i) => {
      const state = i === legIndex && leg.state === 'waiting' ? 'running' : leg.state
      return `${MARK[state]} ${i + 1}. ${legText(leg)}`
    })
    lines.push(`  [${stamp()}] ${message}`)
    process.stdout.write((drawn ? `\x1b[${drawn}A\x1b[J` : '') + lines.map((l) => l.slice(0, width)).join('\n') + '\n')
    drawn = lines.length
  }
}

function printPipeline(record: PipelineRecord): void {
  if (opts.json) return printJson(record)
  out(`Run ${record.id.slice(0, 8)}  ${record.state}  started ${localTime(record.createdAt)}  wallet ${record.wallet}`)
  record.legs.forEach((leg, i) => out(`${MARK[leg.state]} ${i + 1}. ${legText(leg)}`))
}

/** Unlocks the wallet and runs (or continues) a pipeline to the end, showing live status. */
async function execute(record: PipelineRecord): Promise<void> {
  const signer = await unlock(store, record.wallet, await askPassword())
  if (signer.evm.address !== record.fromAddress) throw new Error('The wallet no longer matches the address this run was created for')
  const deps = await runDeps()
  process.once('SIGINT', () => {
    console.error(`\nStopped. A transaction already submitted continues on-chain; pick the run up again with "chainer resume ${record.id.slice(0, 8)}${opts.testnet ? ' --testnet' : ''}".`)
    process.exit(130)
  })
  if (!opts.json) out(`Run ${record.id.slice(0, 8)}`)
  const result = await runPipeline(record, { store: runStore, settings, signer, providers: deps.providers, adapterFor: deps.adapterFor, onEvent: liveView() })
  if (opts.json) printJson(result)
  else if (result.state === 'done') {
    const last = result.legs.at(-1)!
    out(`Done. Received ${fmt(last.received!, last.to)} at ${last.toAddress}`)
  } else {
    const failed = result.legs.findIndex((l) => l.state === 'failed')
    out(`Stopped at leg ${failed + 1}.${failed > 0 ? ' Earlier legs are complete and their funds are in your wallet.' : ''}`)
    out(`After fixing the cause, continue with "chainer resume ${result.id.slice(0, 8)}${opts.testnet ? ' --testnet' : ''}".`)
    process.exitCode = 1
  }
}

interface PlanFile {
  wallet?: string
  legs?: { amount?: number | string; from?: string; to?: string; recipient?: string }[]
}

async function pipelineCommand(sub: string | undefined, file: string | undefined): Promise<void> {
  if (sub !== 'run' || !file) throw new Error('Use: chainer pipeline run <plan.yaml>')
  const plan = parseYaml(await readFile(file, 'utf8')) as PlanFile
  if (!Array.isArray(plan?.legs) || plan.legs.length === 0) throw new Error('The plan file needs a "legs" list (see chainer --help)')
  const account = findAccount(await loadKeystore(store), opts.wallet ?? plan.wallet)

  const legs: Omit<PipelineLeg, 'state'>[] = []
  for (const [i, spec] of plan.legs.entries()) {
    if (spec.amount === undefined || !spec.from || !spec.to) throw new Error(`Leg ${i + 1} needs "amount", "from" and "to"`)
    const [from, to] = await Promise.all([resolveToken(spec.from), resolveToken(spec.to)])
    const amount = String(spec.amount) === 'all' ? 'all' : parseAmount(String(spec.amount), from).toString()
    if (amount !== 'all') checkLimit(BigInt(amount), from)
    const toAddress = spec.recipient ?? account.addresses.evm
    if (!(await runDeps()).adapterFor(to.chainKey).validateAddress(toAddress)) throw new Error(`Leg ${i + 1}: "${toAddress}" is not a valid address`)
    if (i < plan.legs.length - 1 && toAddress !== account.addresses.evm) throw new Error(`Leg ${i + 1} sends to another address, so the next leg would have nothing to continue with`)
    legs.push({ from, to, amount, toAddress })
  }
  const record = newPipeline(account.name, account.addresses.evm, legs)

  if (!opts.json) {
    out(`Plan with ${legs.length} leg${legs.length === 1 ? '' : 's'}, wallet ${account.name}${opts.testnet ? ', on test networks' : ''}:`)
    record.legs.forEach((leg, i) => out(`  ${i + 1}. ${legText(leg)}`))
  }
  if (opts['dry-run']) {
    // Quote each leg with what the one before it would deliver at worst.
    const { providers } = await runDeps()
    let carried: bigint | undefined
    for (const [i, leg] of record.legs.entries()) {
      const amount = leg.amount === 'all' ? carried : BigInt(leg.amount)
      if (amount === undefined) {
        out(`  ${i + 1}. sends the whole balance; quoted when it runs`)
        continue
      }
      const { quotes, errors } = await findRoutes({ from: leg.from, to: leg.to, amount, fromAddress: record.fromAddress, toAddress: leg.toAddress, slippage: settings.slippage }, providers, settings, preference())
      if (quotes.length === 0) throw new Error(`Leg ${i + 1} has no route${errors.length ? `: ${errors.join('; ')}` : ''}`)
      const q = quotes[0]!
      out(`  ${i + 1}. would receive ${fmt(q.toAmount, leg.to)} (at worst ${fmt(q.toAmountMin, leg.to)}) via ${q.provider}/${q.tool}, about ${duration(q.etaSeconds)}`)
      carried = q.toAmountMin
    }
    return out('Dry run: nothing was signed or sent.')
  }
  if (!opts.yes && !(await confirm('Run this plan? Each leg starts by itself once the previous one has arrived.'))) return out('Cancelled.')
  await execute(record)
}

async function findRun(id: string | undefined): Promise<PipelineRecord> {
  if (!id) throw new Error('Give the id of a run (see "chainer status")')
  const matches = (await listPipelines(runStore)).filter((r) => r.id.startsWith(id))
  if (matches.length !== 1) throw new Error(matches.length ? `"${id}" matches several runs; give more characters` : `No run with id "${id}"${opts.testnet ? '' : ' (add --testnet for test runs)'}`)
  return matches[0]!
}

async function statusCommand(id: string | undefined): Promise<void> {
  if (id) return printPipeline(await findRun(id))
  const records = await listPipelines(runStore)
  if (opts.json) return printJson(records)
  if (records.length === 0) return out('No runs yet.')
  table([
    ['ID', 'STARTED', 'STATE', 'LEGS', 'TRANSFER'],
    ...records.map((r) => {
      const [first, last] = [r.legs[0]!, r.legs.at(-1)!]
      const done = r.legs.filter((l) => l.state === 'done').length
      const amount = first.amount === 'all' ? `all ${first.from.symbol}` : fmt(first.amount, first.from)
      return [r.id.slice(0, 8), localTime(r.createdAt), r.state, `${done}/${r.legs.length}`, `${amount} ${first.from.chainKey} -> ${last.to.symbol} ${last.to.chainKey}`]
    }),
  ])
}

async function resumeCommand(id: string | undefined): Promise<void> {
  const record = await findRun(id)
  if (record.state === 'done') return printPipeline(record)
  await execute(record)
}

// ---- config -------------------------------------------------------------

async function configCommand(args: string[]): Promise<void> {
  const [sub, a, b] = args
  const next: Settings = structuredClone(settings)
  if (sub === 'show' || sub === undefined) return printJson(settings)

  if (sub === 'set' && a && b !== undefined) {
    if (a === 'prefer') {
      if (b !== 'cheapest' && b !== 'fastest') throw new Error('prefer must be "cheapest" or "fastest"')
      next.prefer = b
    } else if (a === 'slippage') {
      const n = Number(b)
      if (!(n > 0 && n < 0.5)) throw new Error('slippage is a fraction between 0 and 0.5, e.g. 0.005 for 0.5 %')
      next.slippage = n
    } else if (a === 'maxUsdPerTransfer') {
      const n = b === 'off' ? null : Number(b)
      if (n !== null && !(n > 0)) throw new Error('maxUsdPerTransfer must be a positive number or "off"')
      next.maxUsdPerTransfer = n
    } else if (a === 'maxHops') {
      const n = Number(b)
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error('maxHops must be a whole number from 1 to 5')
      next.maxHops = n
    } else throw new Error(`Unknown setting "${a}"`)
  } else if (sub === 'rpc' && a && b) {
    const chain = findChain(await allChains(), a)
    if (b === 'default') delete next.rpc[chain.key]
    else if (/^https?:\/\//.test(b)) next.rpc[chain.key] = b
    else throw new Error('Give an http(s) URL, or "default" to remove the override')
  } else if (sub === 'avoid' && (a === 'add' || a === 'remove') && b) {
    const rest = next.avoidTokens.filter((t) => t.toLowerCase() !== b.toLowerCase())
    next.avoidTokens = a === 'add' ? [...rest, b] : rest
  } else {
    throw new Error('Use: chainer config show | set <key> <value> | rpc <chain> <url|default> | avoid <add|remove> <token>')
  }
  await saveSettings(store, next)
  printJson(next)
}

// ---- entry --------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...rest] = positionals
  if (opts.help || !command) return out(HELP)
  switch (command) {
    case 'wallet':
      return walletCommand(rest[0])
    case 'chains':
      return chainsCommand()
    case 'balances':
      return balancesCommand(rest[0])
    case 'quote':
      return quoteCommand(rest)
    case 'send':
      return sendCommand(rest)
    case 'pipeline':
      return pipelineCommand(rest[0], rest[1])
    case 'status':
      return statusCommand(rest[0])
    case 'resume':
      return resumeCommand(rest[0])
    case 'config':
      return configCommand(rest)
    default:
      throw new Error(`Unknown command "${command}". Run "chainer --help".`)
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
