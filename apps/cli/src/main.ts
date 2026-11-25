import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { parse as parseYaml } from 'yaml'
import {
  addAccount,
  addressSlot,
  bitcoinAdapter,
  BUILTIN_CHAINS,
  chainAddress,
  evmAdapter,
  findAccount,
  findChain,
  findPipelineRoutes,
  findRoutes,
  formatUnits,
  GEO_RESTRICTIONS,
  geoKeys,
  geoNotices,
  geoStatement,
  lifiChains,
  addAddress,
  afterRun,
  dueState,
  feesAcceptable,
  listSchedules,
  newSchedule,
  parseDuration,
  removeSchedule,
  routeCostUsd,
  saveSchedule,
  type Schedule,
  type Trigger,
  chooseSaved,
  listRoutes,
  loadRoute,
  removeRoute,
  saveRoute,
  type SavedRoute,
  type Signer,
  TransitPool,
  transitAllowed,
  removeAddress,
  resolveRecipient,
  isNative,
  lifiProvider,
  estimateGasUsd,
  parseGasTopUp,
  persistTransit,
  planGasTopUp,
  stopOverUsd,
  stopOvers,
  type StopOver,
  planSweep,
  sdkStatus,
  cctpProvider,
  atomiqProvider,
  lifiToken,
  lifiTokens,
  mayaProvider,
  listPipelines,
  loadKeystore,
  loadSettings,
  newMnemonic,
  newPipeline,
  parseUnits,
  pipelineFromRoute,
  refreshAddresses,
  routeEta,
  routeNetUsd,
  runPipeline,
  saveSettings,
  solanaAdapter,
  thorchainProvider,
  unlock,
  type AccountRecord,
  type Chain,
  type ChainAdapter,
  type GeoNotice,
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
import { ask, askHidden, askPassword, confirm } from './prompt.ts'

const HELP = `chainer - move tokens between blockchains over the best route

Usage:
  chainer wallet init [--name <name>]         Create a wallet with a new seed phrase
  chainer wallet import [--name <name>]       Import a seed phrase or private key
  chainer wallet list                         Show wallets and their addresses
  chainer wallet refresh                      Add Solana and Bitcoin addresses to a wallet made earlier
  chainer chains [--testnets]                 List supported chains
  chainer balances <chain>                    Show the wallet's tokens on a chain
  chainer quote <amount> <token> <chain> [<to-token>] <to-chain>
                                              Compare routes without sending anything
  chainer send  <amount> <token> <chain> [<to-token>] <to-chain>
                                              Send over the best route and follow it live
  chainer sweep <from-chain> <to-chain> [--tokens USDC,DAI] [--target USDC]
                                              Move a whole wallet's tokens to another chain, one transfer per token
  chainer route save <name> <amount|all> <token> <chain> [<to-token>] <to-chain> [--min <amount>] [--fallback]
  chainer route save-sweep <name> <from-chain> <to-chain> [--tokens ...] [--target ...]
  chainer route list | show <name> | remove <name> | run <name>
                                              Keep a route under a name and run it later (re-quoted along the saved path)
  chainer schedule add <route> --at <time> | --every <1h|1d..> [--start <time>] | --when-fees-below <usd> [--check-every 30m] [--repeat]
  chainer schedule list | remove <id>         Run a saved route later; the daemon below carries them out
  chainer daemon [--once] [--poll 60s]        Run due schedules (needs CHAINER_PASSWORD or the password once at start)
  chainer pipeline run <plan.yaml>            Run a chain of transfers, each starting when
                                              the previous one has arrived
  chainer geo                                 List bridges with geo restrictions and where they apply
  chainer providers                           List route sources, and which optional SDKs are installed
  chainer status [<id>]                       List runs, or show one in detail
  chainer resume <id>                         Continue a run that stopped or failed
  chainer book list | add <label> <chain> <address> | remove <label> [<chain>]
                                              Named recipient addresses; use the label after --to
  chainer config show
  chainer config set <prefer|slippage|maxUsdPerTransfer|maxHops|gasTopUpMode|gasTopUpMultiplier|gasTopUpFixedUsd|blockcypher> <value>   (blockcypher on|off: Dogecoin and Dash data, off by default)
  chainer config rpc <chain> <url|default>    Use your own RPC node for a chain
  chainer config avoid <add|remove> <token>   Tokens never to route through or into

Options:
  --wallet <name>            Wallet to use (default: the first one)
  --prefer cheapest|fastest  Ranking for this run (default: from config)
  --max-hops <n>             Most legs an automatic route may have (default: from config)
  --to <address>             Recipient (default: your own address)
  --testnet                  Run on the test networks of the named chains, with test funds
  --gas-topup <off|2x|$3>    Gas sent ahead to a recipient with none: off, a multiple of the estimated gas cost, or a fixed value
  --dry-run                  Stop before signing
  --yes                      Do not ask for confirmation (the location confirmation for
                             geo-restricted bridges is always asked)
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

Routes and bridge transactions come from LI.FI (li.fi). chainer is independent of LI.FI;
its terms apply to your use of its contracts. See "Third-party services" in the README.

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
    tokens: { type: 'string' },
    min: { type: 'string' },
    at: { type: 'string' },
    every: { type: 'string' },
    start: { type: 'string' },
    'when-fees-below': { type: 'string' },
    'check-every': { type: 'string' },
    repeat: { type: 'boolean' },
    once: { type: 'boolean' },
    'gas-topup': { type: 'string' },
    poll: { type: 'string' },
    fallback: { type: 'boolean' },
    target: { type: 'string' },
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
  ['sol', 'USDC'],
  ['sol', 'SOL'],
  ['btc', 'BTC'],
]

let chainList: Promise<Chain[]> | undefined
const allChains = () => (chainList ??= lifiChains(fetchFn).then((found) => [...found, ...BUILTIN_CHAINS.filter((t) => !found.some((c) => c.key === t.key))]))
const adapterFor = (chain: Chain): ChainAdapter => {
  const o = { fetch: fetchFn, rpcUrl: settings.rpc[chain.key], blockcypher: settings.blockcypher }
  return chain.family === 'solana' ? solanaAdapter(chain, o) : chain.family === 'bitcoin' ? bitcoinAdapter(chain, o) : evmAdapter(chain, o)
}

/** The wallet's address on a chain, from the public list stored with the wallet. */
function ownAddress(account: AccountRecord, chain: Pick<Chain, 'family' | 'key' | 'name'>): string {
  const address = account.addresses[addressSlot(chain)]
  if (address) return address
  throw new Error(
    account.type === 'key'
      ? `Wallet "${account.name}" was made from a single EVM private key and has no address on ${chain.name}. Import a seed phrase to use it.`
      : `Wallet "${account.name}" has no ${chain.name} address stored yet. Run "chainer wallet refresh" once to add the new chains.`,
  )
}

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
  // Atomiq needs its optional SDK packages; without them it is left out.
  const atomiq = await atomiqProvider(fetchFn, chains, { dir: dataDir(), testnet: !!opts.testnet })
  const providers = [lifiProvider(fetchFn, chains, settings), cctpProvider(fetchFn, chains), thorchainProvider(fetchFn, chains), mayaProvider(fetchFn, chains), ...(atomiq ? [atomiq] : [])].filter((p) => !settings.disabledProviders.includes(p.name))
  return { providers, adapterFor: (key: string) => adapterFor(byKey(key)), chainName: (key: string) => byKey(key).name }
}

// ---- wallet -------------------------------------------------------------

async function walletCommand(sub: string | undefined): Promise<void> {
  const keystore = await loadKeystore(store)
  if (sub === 'list') {
    if (opts.json) return printJson(keystore.accounts.map(({ name, type, addresses }) => ({ name, type, addresses })))
    if (keystore.accounts.length === 0) return out('No wallets yet. Create one with "chainer wallet init".')
    const shown = ['evm', 'sol', 'btc', 'ltc', 'doge', 'bch', 'dash']
    return table([['NAME', 'TYPE', ...shown.map((k) => k.toUpperCase())], ...keystore.accounts.map((a) => [a.name, a.transit ? `transit (${a.transit.chainKey})` : a.type, ...shown.map((k) => a.addresses[k] ?? '-')])])
  }
  if (sub === 'refresh') {
    const record = await refreshAddresses(store, opts.wallet, await askPassword())
    return out(`Wallet "${record.name}" now lists: ${Object.entries(record.addresses).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  }
  if (sub !== 'init' && sub !== 'import') throw new Error('Use: chainer wallet init | import | list | refresh')

  const name = opts.name ?? (keystore.accounts.length === 0 ? 'main' : `wallet${keystore.accounts.length + 1}`)
  const secret = sub === 'init' ? newMnemonic() : await askHidden('Seed phrase or private key (input hidden): ')
  const password = await askPassword(keystore.accounts.length === 0 ? 'Choose a wallet password (min. 8 characters): ' : 'Wallet password: ')
  if (keystore.accounts.length === 0 && !process.env.CHAINER_PASSWORD && (await askHidden('Repeat the password: ')) !== password) {
    throw new Error('The passwords do not match')
  }
  const record = await addAccount(store, name, secret, password)
  out(`Wallet "${record.name}" saved. EVM address: ${record.addresses.evm}`)
  for (const [key, address] of Object.entries(record.addresses)) if (key !== 'evm' && key !== 'sold' && key !== 'btct') out(`${key.toUpperCase()} address: ${address}`)
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
  const address = ownAddress(account, chain)
  const balances = await adapterFor(chain).getBalances(address, tokens)
  const held = tokens
    .map((token, i) => ({ token, balance: balances[i]!, usd: token.priceUsd === undefined ? undefined : (Number(balances[i]!) / 10 ** token.decimals) * token.priceUsd }))
    .filter((h) => h.balance > 0n)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
  if (opts.json) return printJson(held)
  out(`${account.name} (${address}) on ${chain.name}`)
  if (held.length === 0) return out('No tokens found.')
  table([['TOKEN', 'BALANCE', 'VALUE', 'ADDRESS'], ...held.map((h) => [h.token.symbol, fmt(h.balance, h.token), usd(h.usd), h.token.address])])
}

// ---- geo restrictions ---------------------------------------------------

const regionsText = (n: GeoNotice) => `${n.onlyIn ? 'only available in' : 'not available in'}: ${n.regions.join(', ')}`

/**
 * The location form. Shown whenever a route uses bridges whose terms restrict countries; the run
 * only goes ahead if the user types "yes". --yes does not skip it. Test-network runs move no
 * real value and skip it.
 */
async function geoForm(notices: GeoNotice[], intro: string): Promise<boolean> {
  if (notices.length === 0 || opts.testnet) return true
  const e = (line = '') => console.error(line)
  e()
  e('!! GEO-RESTRICTED SERVICES !!')
  e(intro)
  e()
  for (const n of notices) {
    e(`  ${n.name} - ${regionsText(n)}`)
    if (n.note) e(`    ${n.note}`)
    e(`    Source: ${n.terms}`)
  }
  e()
  e('Using a service from a place it excludes can break its terms and the law that applies to you.')
  e(`  ${geoStatement(notices)}`)
  return /^yes$/i.test(await ask('Type "yes" to confirm, anything else cancels: '))
}

/**
 * Set while the daemon runs a schedule: nobody is there to answer, so only the location
 * confirmations given when the schedule was created count, and an optional fee limit applies.
 */
let unattended: { geoAccepted: string[]; feesBelowUsd?: number } | undefined
/** Why the last saved-route run did not send anything, when the reason was the fee limit. */
let waitingForFees = false

/** Bridge keys the run may use for restricted services, or undefined if the user declined. */
async function geoAcceptance(route: Route): Promise<string[] | undefined> {
  const notices = geoNotices(route.legs)
  const keys = geoKeys(route.legs)
  if (unattended) return keys.every((k) => unattended!.geoAccepted.includes(k)) ? keys : undefined
  return (await geoForm(notices, 'This route uses:')) ? keys : undefined
}

async function providersCommand(): Promise<void> {
  const sdks = await sdkStatus()
  if (opts.json) return printJson({ builtIn: ['lifi', 'cctp', 'thorchain', 'maya'], optional: sdks })
  out('Built in: lifi, cctp, thorchain, maya')
  for (const s of sdks) {
    out(`${s.provider}: ${s.installed ? 'installed' : s.error ? `broken (${s.error})` : `not installed, ${s.gives} is not offered; add it with "npm install --no-save ${s.pkgs.join(' ')}"`}`)
  }
}

function geoCommand(): void {
  const rows = Object.entries(GEO_RESTRICTIONS).map(([key, r]) => [key, r.name, `${r.onlyIn ? 'only in' : 'not in'}: ${r.regions.join(', ')}`, settings.lifi.denyBridges.includes(key) ? 'denied' : ''])
  if (opts.json) return printJson(GEO_RESTRICTIONS)
  table([['BRIDGE', 'SERVICE', 'COUNTRIES AND REGIONS', 'DEFAULT'], ...rows])
  out()
  out('From the terms of each service, see docs/PLAN.md. Bridges not listed have no geo restriction in their terms, or no terms.')
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
  const toAddress = opts.to ? resolveRecipient(settings, opts.to, toChain.key) : ownAddress(account, toChain)
  if (!adapterFor(toChain).validateAddress(toAddress)) throw new Error(`"${toAddress}" is not a valid address on ${toChain.name}`)
  checkLimit(amount, from)
  return { request: { from, to, amount, fromAddress: ownAddress(account, fromChain), toAddress, slippage: settings.slippage }, fromChain, toChain, wallet: account.name }
}

async function search(plan: Plan): Promise<Route[]> {
  const { providers } = await runDeps()
  const chains = await allChains()
  const account = findAccount(await loadKeystore(store), plan.wallet)
  // Stop-over funds wait in the wallet's own address on whichever chain the route passes through;
  // a wallet with no address there (a single private key) gets a transit wallet for that chain.
  transitPool = new TransitPool((await loadKeystore(store)).accounts)
  const pool = transitPool
  const addressOn = (chainKey: string) => {
    const chain = chains.find((c) => c.key === chainKey)!
    return account.addresses[addressSlot(chain)] ?? pool.addressOn(chain)
  }
  const found = await findPipelineRoutes(plan.request, providers, settings, { prefer: preference(), hubs: hubTokens, maxHops: maxHops(), addressOn })
  const { errors } = found
  const routes = found.routes.filter((r) => transitAllowed(r, pool, gasSetting().mode !== 'off'))
  if (routes.length === 0) {
    if (found.routes.length > 0) throw new Error('The only routes stop on a chain where this wallet has no address, with a token other than that chain\'s own coin. Import a seed phrase wallet, or give another route.')
    throw new Error(errors.length ? `No route found. ${errors.join('; ')}` : 'No route found, also not through other chains.')
  }
  for (const e of errors) console.error(`Note: ${e}`)
  return routes
}

/** The transit wallets of the last route search; stored when a route that uses them is about to run. */
let transitPool: TransitPool | undefined

/** Turns the chosen route into a run. Transit wallets it passes through are stored (encrypted) first. */
async function buildPipeline(route: Route, wallet: string, accepted: string[]): Promise<PipelineRecord> {
  const walletOf = transitPool ? await persistTransit(store, transitPool, route, () => askPassword()) : undefined
  return pipelineFromRoute(route, wallet, accepted, walletOf)
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
      return [String(i + 1), routeVia(r) + (geoKeys(r.legs).length ? ' [geo]' : ''), fmt(last.toAmount, to), fmt(last.toAmountMin, to), usd(r.legs.reduce((s, q) => s + q.costUsd, 0)), usd(routeNetUsd(r)), duration(routeEta(r))]
    }),
  ])
  if (routes.slice(0, 8).some((r) => geoKeys(r.legs).length)) {
    out()
    out('[geo] = uses a service with geo restrictions (chainer geo); you must confirm your location before it is used.')
  }
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

/** The extra transfer that gives a gas-less recipient some of the destination coin, if the setting asks for one. */
async function gasTopUpRoute(plan: Plan, sourceBalance: bigint, override?: string): Promise<Route | undefined> {
  // --gas-topup, or the plan file's gasTopUp, overrides the saved setting for this run.
  const text = override ?? opts['gas-topup']
  const setting = text ? parseGasTopUp(text, settings.gasTopUp) : settings.gasTopUp
  if (setting.mode === 'off') return undefined
  const { request, toChain } = plan
  const destNative = await lifiToken(fetchFn, toChain, toChain.nativeSymbol)
  const [have] = await adapterFor(toChain).getBalances(request.toAddress, [destNative])
  // Twice (by default) what one onward transaction costs at the destination's current gas price.
  const estimatedGasUsd = setting.mode === 'multiplier' ? await estimateGasUsd(toChain, fetchFn) : undefined
  const { topUp, why } = planGasTopUp(setting, { source: request.from, destination: request.to, destNative, destNativeBalance: have!, mainAmount: request.amount, sourceBalance, estimatedGasUsd })
  if (!topUp) {
    if (why) out(`No gas top-up: ${why}.`)
    return undefined
  }
  try {
    return (await search({ ...plan, request: { ...request, to: destNative, amount: topUp.amount } }))[0]
  } catch (err) {
    out(`No gas top-up: no route for it (${(err as Error).message}).`)
    return undefined
  }
}

/** Runs the gas top-up after the main transfer; a problem here never undoes or hides the main transfer. */
async function runGasTopUp(route: Route | undefined, wallet: string): Promise<void> {
  if (!route) return
  out()
  out(`Gas top-up: ${fmt(route.legs[0]!.request.amount, route.legs[0]!.request.from)} -> ${route.legs.at(-1)!.request.to.symbol} on ${route.legs.at(-1)!.request.to.chainKey}`)
  const accepted = await geoAcceptance(route)
  if (!accepted) return out('Skipped: the location confirmation was not given.')
  try {
    await execute(await buildPipeline(route, wallet, accepted))
  } catch (err) {
    out(`The gas top-up stopped: ${(err as Error).message}`)
  }
}

/** The gas top-up setting for this run: the saved one, or --gas-topup. */
const gasSetting = () => (opts['gas-topup'] ? parseGasTopUp(opts['gas-topup'], settings.gasTopUp) : settings.gasTopUp)

interface StopTopUp {
  stop: StopOver
  route: Route
  usd: number
}

/**
 * Gas for the chains a route stops on. A stop-over holding a token other than the chain's coin
 * needs some of that coin to pay for the next leg, so a small extra transfer from the source
 * wallet goes there first, sized from the next leg's own quoted cost (times the multiplier, or
 * the fixed value). Nothing is returned for stop-overs that already have gas or hold the coin.
 */
async function stopOverTopUps(route: Route, sourceBalance: bigint, mainAmount: bigint): Promise<StopTopUp[]> {
  const setting = gasSetting()
  if (setting.mode === 'off') return []
  const chains = await allChains()
  const first = route.legs[0]!.request
  const found: StopTopUp[] = []
  let spent = mainAmount
  for (const stop of stopOvers(route)) {
    const chain = chains.find((c) => c.key === stop.chainKey)!
    const native = await lifiToken(fetchFn, chain, chain.nativeSymbol)
    const [have] = await adapterFor(chain).getBalances(stop.address, [native])
    if (have! > 0n) continue
    const estimated = stop.nextCostUsd > 0 || setting.mode !== 'multiplier' ? undefined : await estimateGasUsd(chain, fetchFn)
    const { usd, why } = stopOverUsd(setting, stop, estimated)
    if (!usd) throw new Error(`Cannot send gas ahead to ${chain.name}: ${why ?? 'no amount'}`)
    const price = first.from.priceUsd
    if (!price) throw new Error(`Cannot send gas ahead to ${chain.name}: the price of ${first.from.symbol} is unknown`)
    const amount = BigInt(Math.ceil((usd / price) * 10 ** first.from.decimals))
    if (spent + amount > sourceBalance) throw new Error(`The wallet cannot pay the gas for ${chain.name} (about ${usd.toFixed(2)} USD) on top of the transfer; send a smaller amount, or turn the gas top-up off`)
    spent += amount
    // The transfer to the stop-over address must be one leg, or it would need stop-overs of its own.
    const keep = transitPool
    let candidates: Route[]
    try {
      candidates = await search({ request: { ...first, to: native, amount, toAddress: stop.address }, fromChain: chains.find((c) => c.key === first.from.chainKey)!, toChain: chain, wallet: await walletNameFor(first.fromAddress) })
    } finally {
      transitPool = keep
    }
    const direct = candidates.find((r) => r.legs.length === 1)
    if (!direct) throw new Error(`No direct route to send gas ahead to ${chain.name}; turn the gas top-up off or use a seed phrase wallet`)
    found.push({ stop, route: direct, usd })
  }
  return found
}

/** Name of the wallet that owns an address. */
async function walletNameFor(address: string): Promise<string> {
  const owner = (await loadKeystore(store)).accounts.find((a) => Object.values(a.addresses).includes(address))
  if (!owner) throw new Error('The sending address does not belong to a wallet here')
  return owner.name
}

function printStopOvers(stops: StopTopUp[]): void {
  for (const s of stops) out(`Gas ahead: about ${usd(s.usd)} of ${s.route.legs[0]!.request.from.symbol} -> ${s.route.legs[0]!.request.to.symbol} on ${s.stop.chainKey} (needed for the next leg), via ${routeVia(s.route)}`)
}

/** Sends the stop-over gas before the main route starts; if one fails the main route is never started. */
async function runStopOverTopUps(stops: StopTopUp[], wallet: string, accepted: string[]): Promise<void> {
  for (const s of stops) {
    out()
    out(`Sending gas to ${s.stop.chainKey} first`)
    await execute(await buildPipeline(s.route, wallet, accepted))
  }
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
  const stops = await stopOverTopUps(routes[0]!, balance!, request.amount)
  printStopOvers(stops)
  const topUp = await gasTopUpRoute(plan, balance! - stops.reduce((s, t) => s + t.route.legs[0]!.request.amount, 0n))
  if (topUp) out(`Extra:     ${fmt(topUp.legs[0]!.request.amount, request.from)} for gas as ${topUp.legs.at(-1)!.request.to.symbol} on ${plan.toChain.name} (the recipient has none), via ${routeVia(topUp)}`)
  if (opts['dry-run']) return out('Dry run: nothing was signed or sent.')
  if (!opts.yes && !(await confirm(`Send ${fmt(request.amount, request.from)}${stops.length ? ', the gas for the stop-overs' : ''}${topUp ? ' and the gas top-up' : ''} over this route?`))) return out('Cancelled.')
  const accepted = await geoAcceptance({ legs: [...stops.flatMap((s) => s.route.legs), ...routes[0]!.legs] })
  if (!accepted) return out('Cancelled: the location confirmation was not given. Nothing was sent.')
  await runStopOverTopUps(stops, plan.wallet, accepted)
  await execute(await buildPipeline(routes[0]!, plan.wallet, accepted))
  await runGasTopUp(topUp, plan.wallet)
}

// ---- sweep ----------------------------------------------------------------

async function sweepCommand(args: string[]): Promise<void> {
  if (args.length !== 2) throw new Error('Use: chainer sweep <from-chain> <to-chain> [--tokens USDC,DAI] [--target USDC]')
  const account = findAccount(await loadKeystore(store), opts.wallet)
  const [fromChain, toChain] = await Promise.all([resolveChain(args[0]!), resolveChain(args[1]!)])
  const fromAddress = ownAddress(account, fromChain)
  const toAddress = opts.to ? resolveRecipient(settings, opts.to, toChain.key) : ownAddress(account, toChain)
  if (!adapterFor(toChain).validateAddress(toAddress)) throw new Error(`"${toAddress}" is not a valid address on ${toChain.name}`)

  const wanted = opts.tokens ? opts.tokens.split(',').map((s) => s.trim().toLowerCase()) : undefined
  const sourceTokens = (await lifiTokens(fetchFn, fromChain)).filter((t) => !wanted || wanted.includes(t.symbol.toLowerCase()))
  const balances = await adapterFor(fromChain).getBalances(fromAddress, sourceTokens)
  const holdings = sourceTokens.map((token, i) => ({ token, balance: balances[i]! }))

  // Where each token lands: one chosen token, or the same token on the destination.
  const destTokens = await lifiTokens(fetchFn, toChain)
  const chosen = opts.target ? await lifiToken(fetchFn, toChain, opts.target) : undefined
  const target = (t: Token): Token | undefined => chosen ?? destTokens.find((d) => (isNative(t) ? isNative(d) : d.symbol.toLowerCase() === t.symbol.toLowerCase()))

  const { providers } = await runDeps()
  const chains = await allChains()
  const addressOn = (chainKey: string) => ownAddress(account, chains.find((c) => c.key === chainKey)!)
  const hubs = await hubTokens()
  const findRoute = async (from: Token, to: Token, amount: bigint): Promise<Route | undefined> => {
    const request: QuoteRequest = { from, to, amount, fromAddress, toAddress, slippage: settings.slippage }
    const { routes } = await findPipelineRoutes(request, providers, settings, { prefer: preference(), hubs: async () => hubs, maxHops: maxHops(), addressOn })
    return routes[0]
  }

  out(`Looking up routes for ${holdings.filter((h) => h.balance > 0n).length} token(s) on ${fromChain.name}...`)
  const holdingOf = (t: Token) => holdings.find((h) => h.token.address === t.address)?.balance ?? 0n
  const plan = await planSweep({ holdings, target, findRoute })
  if (opts.json) return printJson({ items: plan.items.map((i) => ({ from: i.from.symbol, to: i.to.symbol, amount: i.amount.toString(), via: routeVia(i.route), netUsd: routeNetUsd(i.route) })), skipped: plan.skipped.map((s) => ({ token: s.token.symbol, reason: s.reason })) })
  if (plan.items.length > 0) {
    table([
      ['TOKEN', 'AMOUNT', '-> RECEIVE', 'VIA', 'GAS + FEES', 'NET VALUE', 'TIME'],
      ...plan.items.map((i) => [i.from.symbol, fmt(i.amount, i.from), `${fmt(i.route.legs.at(-1)!.toAmount, i.to)}`, routeVia(i.route) + (geoKeys(i.route.legs).length ? ' [geo]' : ''), usd(i.route.legs.reduce((s, q) => s + q.costUsd, 0)), usd(routeNetUsd(i.route)), duration(routeEta(i.route))]),
    ])
  }
  if (plan.skipped.length > 0) {
    out()
    out('Skipped:')
    for (const s of plan.skipped) out(`  ${s.token.symbol}: ${s.reason}`)
  }
  if (plan.items.length === 0) return out('Nothing to send.')
  if (unattended?.feesBelowUsd !== undefined) {
    const total = plan.items.reduce((sum, i) => sum + routeCostUsd(i.route), 0)
    if (total > unattended.feesBelowUsd) {
      waitingForFees = true
      return out(`Gas and fees are ${usd(total)} in total, above the limit of ${usd(unattended.feesBelowUsd)}; waiting.`)
    }
  }
  out()
  out(`Recipient: ${toAddress} on ${toChain.name}`)
  if (opts['dry-run']) return out('Dry run: nothing was signed or sent.')
  if (!opts.yes && !(await confirm(`Send ${plan.items.length} transfer(s) one after the other?`))) return out('Cancelled.')
  const accepted = await geoAcceptance({ legs: plan.items.flatMap((i) => i.route.legs) })
  if (!accepted) return out('Cancelled: the location confirmation was not given. Nothing was sent.')

  // Each token is its own run, so a failure in one leaves the others untouched.
  for (const [n, item] of plan.items.entries()) {
    out()
    out(`[${n + 1}/${plan.items.length}] ${item.from.symbol}`)
    try {
      const stops = await stopOverTopUps(item.route, holdingOf(item.from), item.amount)
      printStopOvers(stops)
      await runStopOverTopUps(stops, account.name, accepted)
      await execute(await buildPipeline(item.route, account.name, accepted))
    } catch (err) {
      out(`${item.from.symbol} stopped: ${(err as Error).message}`)
      process.exitCode = 1
    }
  }
}

// ---- schedules and the daemon -----------------------------------------------

const triggerText = (t: Trigger) =>
  t.kind === 'at' ? `once at ${localTime(t.at)}` : t.kind === 'every' ? `every ${Math.round(t.everyMs / 60_000)} min${t.start ? ` from ${localTime(t.start)}` : ''}` : `when fees are at most ${usd(t.feesBelowUsd)} (checked every ${Math.round(t.checkEveryMs / 60_000)} min${t.repeat ? ', repeating' : ''})`

function parseTime(text: string): string {
  const d = new Date(text)
  if (Number.isNaN(d.getTime())) throw new Error(`"${text}" is not a time; use e.g. 2026-12-01T10:00 (your local time) or 2026-12-01T10:00:00Z`)
  return d.toISOString()
}

async function scheduleCommand(args: string[]): Promise<void> {
  const [sub, name] = args
  if (sub === 'list' || sub === undefined) {
    const all = await listSchedules(store)
    if (opts.json) return printJson(all)
    if (all.length === 0) return out('No schedules. Add one with "chainer schedule add <route> --at <time>".')
    return table([['ID', 'ROUTE', 'WHEN', 'LAST RUN', 'RESULT'], ...all.map((s) => [s.id.slice(0, 8), s.route, s.done ? 'done' : triggerText(s.trigger), s.lastRun ? localTime(s.lastRun) : '-', s.lastResult ?? ''])])
  }
  if (sub === 'remove' && name) {
    const gone = await removeSchedule(store, name)
    return out(`Removed the schedule for "${gone.route}".`)
  }
  if (sub !== 'add' || !name) throw new Error('Use: chainer schedule add <route> --at|--every|--when-fees-below ... | list | remove <id>')
  const saved = await loadRoute(store, name)
  if (opts.testnet) throw new Error('Schedules run on the main networks; test the saved route with "chainer route run <name> --testnet" instead')
  const kinds = [opts.at, opts.every, opts['when-fees-below']].filter((v) => v !== undefined).length
  if (kinds !== 1) throw new Error('Give exactly one of --at, --every or --when-fees-below')
  const trigger: Trigger = opts.at
    ? { kind: 'at', at: parseTime(opts.at) }
    : opts.every
      ? { kind: 'every', everyMs: parseDuration(opts.every), start: opts.start ? parseTime(opts.start) : undefined }
      : { kind: 'when', feesBelowUsd: Number(opts['when-fees-below']), checkEveryMs: parseDuration(opts['check-every'] ?? '30m'), repeat: !!opts.repeat }
  if (trigger.kind === 'when' && !(trigger.feesBelowUsd > 0)) throw new Error('--when-fees-below needs an amount in USD')
  // Nobody answers questions during an unattended run, so the location form is answered now, once.
  const geoAccepted = await askGeoForPlan()
  const schedule = newSchedule(saved.name, trigger, geoAccepted)
  await saveSchedule(store, schedule)
  out(`Scheduled "${saved.name}" ${triggerText(trigger)} (id ${schedule.id.slice(0, 8)}). Start "chainer daemon" to carry it out; it must stay running.`)
  out('Unattended runs sign with this wallet\'s stored key; the daemon needs the password in CHAINER_PASSWORD or typed once at start.')
}

async function runSchedule(s: Schedule, mode: 'run' | 'check'): Promise<Schedule> {
  const now = new Date()
  const own = { wallet: opts.wallet, to: opts.to, tokens: opts.tokens, target: opts.target, yes: opts.yes }
  unattended = { geoAccepted: s.geoAccepted, feesBelowUsd: s.trigger.kind === 'when' ? s.trigger.feesBelowUsd : undefined }
  waitingForFees = false
  opts.yes = true
  let result = 'ok'
  try {
    out(`[${stamp()}] ${mode === 'check' ? 'Checking' : 'Running'} "${s.route}"`)
    await routeCommand(['run', s.route])
    if (process.exitCode) result = 'a transfer stopped; see "chainer status"'
  } catch (err) {
    result = (err as Error).message
    out(`[${stamp()}] "${s.route}" did not run: ${result}`)
  } finally {
    unattended = undefined
    Object.assign(opts, own)
    process.exitCode = undefined
  }
  if (waitingForFees) return { ...s, lastCheck: now.toISOString(), lastResult: 'waiting for lower fees' }
  return afterRun(s, now, result)
}

async function daemonCommand(): Promise<void> {
  const pollMs = opts.poll ? parseDuration(opts.poll.replace(/^(\d+)$/, '$1s')) : 60_000
  await askPassword() // asked once up front, kept in memory
  let stop = false
  process.once('SIGINT', () => (stop = true))
  out(`[${stamp()}] Daemon started${opts.once ? ' (one pass)' : `, checking every ${Math.round(pollMs / 1000)} s; Ctrl-C stops it`}`)
  do {
    for (const s of await listSchedules(store)) {
      const due = dueState(s, new Date())
      if (due === 'wait') continue
      await saveSchedule(store, await runSchedule(s, due))
    }
    if (opts.once || stop) break
    await new Promise((r) => setTimeout(r, pollMs))
  } while (!stop)
  out(`[${stamp()}] Daemon stopped`)
}

// ---- saved routes ---------------------------------------------------------

const savedSummary = (r: SavedRoute) =>
  r.kind === 'transfer' ? `${r.amount === 'all' ? 'all' : 'fixed amount'} ${r.from} -> ${r.to} via ${r.via}${r.fallback ? ' (best route if gone)' : ''}${r.minReceive ? `, min ${r.minReceive}` : ''}` : `sweep ${r.fromChain} -> ${r.toChain}${r.tokens ? ` of ${r.tokens.join(',')}` : ''}${r.target ? ` as ${r.target}` : ''}`

async function routeCommand(args: string[]): Promise<void> {
  const [sub, name, ...rest] = args
  if (sub === 'list' || sub === undefined) {
    const all = await listRoutes(store)
    if (opts.json) return printJson(all)
    if (all.length === 0) return out('No saved routes. Save one with "chainer route save <name> ...".')
    return table([['NAME', 'WHAT'], ...all.map((r) => [r.name, savedSummary(r)])])
  }
  if (!name) throw new Error('Use: chainer route save | save-sweep | list | show | remove | run')
  if (sub === 'show') return printJson(await loadRoute(store, name))
  if (sub === 'remove') {
    await removeRoute(store, name)
    return out(`Removed "${name}".`)
  }

  if (sub === 'save') {
    if (opts.testnet) throw new Error('Save routes without --testnet (they use the main networks); test one with "chainer route run <name> --testnet"')
    const [amountText, tokenSymbol, fromChainQuery] = rest
    if (!amountText || rest.length < 4) throw new Error('Use: chainer route save <name> <amount|all> <token> <chain> [<to-token>] <to-chain>')
    let planArgs = rest
    if (amountText === 'all') {
      // The plan needs a number to quote; the saved route keeps "all".
      const [chain, token] = await Promise.all([resolveChain(fromChainQuery!), resolveChain(fromChainQuery!).then((c) => lifiToken(fetchFn, c, tokenSymbol!))])
      const account = findAccount(await loadKeystore(store), opts.wallet)
      const [balance] = await adapterFor(chain).getBalances(ownAddress(account, chain), [token])
      if (!balance) throw new Error(`The wallet holds no ${token.symbol} on ${chain.name} to base the route on`)
      planArgs = [formatUnits(balance, token.decimals), ...rest.slice(1)]
    }
    const plan = await buildPlan(planArgs)
    const best = (await search(plan))[0]!
    const saved: SavedRoute = {
      kind: 'transfer',
      name,
      createdAt: new Date().toISOString(),
      wallet: opts.wallet,
      from: `${plan.request.from.symbol}@${plan.fromChain.key}`,
      to: `${plan.request.to.symbol}@${plan.toChain.key}`,
      amount: amountText === 'all' ? 'all' : plan.request.amount.toString(),
      recipient: opts.to,
      via: routeVia(best),
      minReceive: opts.min ? parseAmount(opts.min, plan.request.to).toString() : undefined,
      fallback: !!opts.fallback,
    }
    await saveRoute(store, saved)
    return out(`Saved "${name}": ${savedSummary(saved)}`)
  }

  if (sub === 'save-sweep') {
    if (opts.testnet) throw new Error('Save routes without --testnet')
    const [fromChain, toChain] = rest
    if (!fromChain || !toChain) throw new Error('Use: chainer route save-sweep <name> <from-chain> <to-chain> [--tokens ...] [--target ...]')
    const chains = await allChains()
    const saved: SavedRoute = {
      kind: 'sweep',
      name,
      createdAt: new Date().toISOString(),
      wallet: opts.wallet,
      fromChain: findChain(chains, fromChain).key,
      toChain: findChain(chains, toChain).key,
      tokens: opts.tokens?.split(',').map((t) => t.trim()),
      target: opts.target,
      recipient: opts.to,
    }
    await saveRoute(store, saved)
    return out(`Saved "${name}": ${savedSummary(saved)}`)
  }

  if (sub === 'run') {
    const saved = await loadRoute(store, name)
    opts.wallet ??= saved.wallet
    opts.to ??= saved.recipient
    if (saved.kind === 'sweep') {
      opts.tokens ??= saved.tokens?.join(',')
      opts.target ??= saved.target
      return sweepCommand([saved.fromChain, saved.toChain])
    }
    // Amounts are worked out now: "all" is whatever the wallet holds at this moment.
    const [from, to] = await Promise.all([resolveToken(saved.from), resolveToken(saved.to)])
    const [fromChain, toChain] = await Promise.all([resolveChain(saved.from.split('@')[1]!), resolveChain(saved.to.split('@')[1]!)])
    const account = findAccount(await loadKeystore(store), opts.wallet)
    const fromAddress = ownAddress(account, fromChain)
    const toAddress = saved.recipient ? resolveRecipient(settings, saved.recipient, toChain.key) : ownAddress(account, toChain)
    if (!adapterFor(toChain).validateAddress(toAddress)) throw new Error(`"${toAddress}" is not a valid address on ${toChain.name}`)
    const [balance] = await adapterFor(fromChain).getBalances(fromAddress, [from])
    const amount = saved.amount === 'all' ? balance! : BigInt(saved.amount)
    if (amount <= 0n || amount > balance!) throw new Error(`The wallet holds ${fmt(balance!, from)} on ${fromChain.name}, not enough for this saved route`)
    checkLimit(amount, from)
    const plan: Plan = { request: { from, to, amount, fromAddress, toAddress, slippage: settings.slippage }, fromChain, toChain, wallet: account.name }
    const choice = chooseSaved(saved, await search(plan))
    if (unattended?.feesBelowUsd !== undefined && !feesAcceptable(choice.route, unattended.feesBelowUsd)) {
      waitingForFees = true
      return out(`Gas and fees are ${usd(routeCostUsd(choice.route))}, above the limit of ${usd(unattended.feesBelowUsd)}; waiting.`)
    }
    if (choice.usedFallback) out(`The saved path "${saved.via}" is gone; using the best route now: ${routeVia(choice.route)}`)
    printRoutes(plan, [choice.route])
    out()
    out(`Route:     ${routeVia(choice.route)}`)
    out(`Recipient: ${toAddress}`)
    const stops = await stopOverTopUps(choice.route, balance!, amount)
    printStopOvers(stops)
    const topUp = await gasTopUpRoute(plan, balance! - stops.reduce((s, t) => s + t.route.legs[0]!.request.amount, 0n))
    if (topUp) out(`Extra:     ${fmt(topUp.legs[0]!.request.amount, from)} for gas on ${toChain.name} via ${routeVia(topUp)}`)
    if (opts['dry-run']) return out('Dry run: nothing was signed or sent.')
    if (!opts.yes && !(await confirm(`Run "${saved.name}" now${stops.length ? ', with the stop-over gas' : ''}${topUp ? ' and the gas top-up' : ''}?`))) return out('Cancelled.')
    const accepted = await geoAcceptance({ legs: [...stops.flatMap((s) => s.route.legs), ...choice.route.legs] })
    if (!accepted) return out('Cancelled: the location confirmation was not given. Nothing was sent.')
    await runStopOverTopUps(stops, account.name, accepted)
    const record = await buildPipeline(choice.route, account.name, accepted)
    if (saved.amount === 'all') record.legs[0]!.amount = 'all'
    await execute(record)
    return runGasTopUp(topUp, account.name)
  }
  throw new Error('Use: chainer route save | save-sweep | list | show | remove | run')
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
  // Legs that start on a stop-over chain are signed by that chain's transit wallet.
  const others = new Map<string, Signer>()
  for (const name of new Set(record.legs.flatMap((l) => (l.wallet ? [l.wallet] : [])))) others.set(name, await unlock(store, name, await askPassword()))
  const chains = await allChains()
  for (const leg of record.legs) {
    const chain = chains.find((c) => c.key === leg.from.chainKey)
    const legSigner = leg.wallet ? others.get(leg.wallet)! : signer
    if (chain && chainAddress(legSigner, chain) !== (leg.fromAddress ?? record.fromAddress)) throw new Error('The wallet no longer matches the address this run was created for')
  }
  const deps = await runDeps()
  process.once('SIGINT', () => {
    console.error(`\nStopped. A transaction already submitted continues on-chain; pick the run up again with "chainer resume ${record.id.slice(0, 8)}${opts.testnet ? ' --testnet' : ''}".`)
    process.exit(130)
  })
  if (!opts.json) out(`Run ${record.id.slice(0, 8)}`)
  const result = await runPipeline(record, { store: runStore, settings, signer, signerFor: (name) => others.get(name)!, providers: deps.providers, adapterFor: deps.adapterFor, onEvent: liveView() })
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
  /** Overrides the saved gas top-up setting for this plan: off, 3x (times the estimated gas cost) or $5 (fixed). */
  gasTopUp?: string
  legs?: { amount?: number | string; from?: string; to?: string; recipient?: string }[]
}

/** Plans choose bridges at run time: ask once for all restricted bridges; without the confirmation they are simply not used. */
async function askGeoForPlan(): Promise<string[]> {
  const usable = Object.keys(GEO_RESTRICTIONS).filter((k) => !settings.lifi.denyBridges.includes(k))
  const notices = geoNotices(usable.map((tool) => ({ provider: 'lifi', tool })))
  if (opts.testnet) return usable
  if (await geoForm(notices, 'This plan picks its bridges while it runs and may use any of these:')) return usable
  out('Without the confirmation these bridges are left out; the plan continues with the others.')
  return []
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
    const chains = await allChains()
    const [fromChain, toChain] = [chains.find((c) => c.key === from.chainKey)!, chains.find((c) => c.key === to.chainKey)!]
    const toAddress = spec.recipient ? resolveRecipient(settings, spec.recipient, toChain.key) : ownAddress(account, toChain)
    if (!adapterFor(toChain).validateAddress(toAddress)) throw new Error(`Leg ${i + 1}: "${toAddress}" is not a valid address on ${toChain.name}`)
    if (i < plan.legs.length - 1 && toAddress !== ownAddress(account, toChain)) throw new Error(`Leg ${i + 1} sends to another address, so the next leg would have nothing to continue with`)
    legs.push({ from, to, amount, fromAddress: ownAddress(account, fromChain), toAddress })
  }
  const record = newPipeline(account.name, legs[0]!.fromAddress!, legs)

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
      const { quotes, errors } = await findRoutes({ from: leg.from, to: leg.to, amount, fromAddress: leg.fromAddress ?? record.fromAddress, toAddress: leg.toAddress, slippage: settings.slippage }, providers, settings, preference())
      if (quotes.length === 0) throw new Error(`Leg ${i + 1} has no route${errors.length ? `: ${errors.join('; ')}` : ''}`)
      const q = quotes[0]!
      out(`  ${i + 1}. would receive ${fmt(q.toAmount, leg.to)} (at worst ${fmt(q.toAmountMin, leg.to)}) via ${q.provider}/${q.tool}, about ${duration(q.etaSeconds)}`)
      carried = q.toAmountMin
    }
    return out('Dry run: nothing was signed or sent.')
  }
  if (!opts.yes && !(await confirm('Run this plan? Each leg starts by itself once the previous one has arrived.'))) return out('Cancelled.')
  // The bridges are picked while the plan runs, so the form covers every geo-restricted bridge it might use.
  record.geoAccepted = await askGeoForPlan()
  // Gas for the last chain: only when the first leg has a fixed amount to base it on.
  const [first, last] = [record.legs[0]!, record.legs.at(-1)!]
  let topUp: Route | undefined
  if (first.amount !== 'all' && (plan.gasTopUp ?? opts['gas-topup'] ?? settings.gasTopUp.mode) !== 'off') {
    const chains = await allChains()
    const [fromChain, toChain] = [chains.find((c) => c.key === first.from.chainKey)!, chains.find((c) => c.key === last.to.chainKey)!]
    const [balance] = await adapterFor(fromChain).getBalances(first.fromAddress ?? record.fromAddress, [first.from])
    const topUpPlan: Plan = { request: { from: first.from, to: last.to, amount: BigInt(first.amount), fromAddress: first.fromAddress ?? record.fromAddress, toAddress: last.toAddress, slippage: settings.slippage }, fromChain, toChain, wallet: account.name }
    topUp = await gasTopUpRoute(topUpPlan, balance!, plan.gasTopUp)
  }
  await execute(record)
  await runGasTopUp(topUp, account.name)
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
  // Your location may have changed since the run started, so earlier confirmations are asked for again.
  if (record.geoAccepted?.length) {
    const notices = geoNotices(record.geoAccepted.map((tool) => ({ provider: 'lifi', tool })))
    if (!(await geoForm(notices, 'This run was started with a confirmation for:'))) {
      record.geoAccepted = []
      out('Without the confirmation these bridges are left out; the remaining legs use the others.')
    }
  }
  await execute(record)
}

// ---- config -------------------------------------------------------------

async function bookCommand(args: string[]): Promise<void> {
  const [sub, label, chainQuery, address] = args
  if (sub === 'list' || sub === undefined) {
    if (opts.json) return printJson(settings.addressBook)
    if (settings.addressBook.length === 0) return out('The address book is empty. Add one with "chainer book add <label> <chain> <address>".')
    return table([['LABEL', 'CHAIN', 'ADDRESS'], ...settings.addressBook.map((e) => [e.label, e.chainKey, e.address])])
  }
  if (sub === 'add' && label && chainQuery && address) {
    const chain = findChain(await allChains(), chainQuery)
    const next = addAddress(settings, { label, chainKey: chain.key, address }, (a) => adapterFor(chain).validateAddress(a))
    await saveSettings(store, next)
    return out(`Saved "${label}" on ${chain.name}.`)
  }
  if (sub === 'remove' && label) {
    const chain = chainQuery ? findChain(await allChains(), chainQuery) : undefined
    await saveSettings(store, removeAddress(settings, label, chain?.key))
    return out(`Removed "${label}"${chain ? ` on ${chain.name}` : ''}.`)
  }
  throw new Error('Use: chainer book list | add <label> <chain> <address> | remove <label> [<chain>]')
}

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
    } else if (a === 'gasTopUpMode') {
      if (b !== 'off' && b !== 'multiplier' && b !== 'fixed') throw new Error('gasTopUpMode must be "off", "multiplier" or "fixed"')
      next.gasTopUp.mode = b
    } else if (a === 'gasTopUpMultiplier') {
      next.gasTopUp = parseGasTopUp(b + 'x', next.gasTopUp)
    } else if (a === 'gasTopUpFixedUsd') {
      next.gasTopUp = parseGasTopUp('$' + b, next.gasTopUp)
    } else if (a === 'blockcypher') {
      if (b !== 'on' && b !== 'off') throw new Error('blockcypher must be "on" or "off"')
      next.blockcypher = b === 'on'
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
    case 'schedule':
      return scheduleCommand(rest)
    case 'daemon':
      return daemonCommand()
    case 'route':
      return routeCommand(rest)
    case 'sweep':
      return sweepCommand(rest)
    case 'pipeline':
      return pipelineCommand(rest[0], rest[1])
    case 'geo':
      return geoCommand()
    case 'providers':
      return providersCommand()
    case 'status':
      return statusCommand(rest[0])
    case 'resume':
      return resumeCommand(rest[0])
    case 'book':
      return bookCommand(rest)
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
