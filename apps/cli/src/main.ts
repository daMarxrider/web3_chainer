import { parseArgs } from 'node:util'
import {
  addAccount,
  evmAdapter,
  executeQuote,
  findAccount,
  findChain,
  findRoutes,
  formatUnits,
  lifiChains,
  lifiProvider,
  lifiToken,
  lifiTokens,
  listTransfers,
  loadKeystore,
  loadSettings,
  netUsd,
  newMnemonic,
  parseUnits,
  saveSettings,
  trackTransfer,
  unlock,
  type Chain,
  type Prefer,
  type Quote,
  type QuoteRequest,
  type Settings,
  type Token,
  type TransferRecord,
} from '@chainer/core'
import { dataDir, fileStore, makeFetch } from './env.ts'
import { ask, askHidden, askPassword, confirm } from './prompt.ts'

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
                                              Send over the best route and track it
  chainer status [<id>]                       List transfers, or resume tracking one
  chainer config show
  chainer config set <prefer|slippage|maxUsdPerTransfer|proxy> <value>
  chainer config rpc <chain> <url|default>    Use your own RPC node for a chain
  chainer config avoid <add|remove> <token>   Tokens never to route through or into

Options:
  --wallet <name>            Wallet to use (default: the first one)
  --prefer cheapest|fastest  Ranking for this run (default: from config)
  --to <address>             Recipient (default: your own address)
  --dry-run                  Stop before signing
  --yes                      Do not ask for confirmation
  --json                     Machine-readable output

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
    to: { type: 'string' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' },
    json: { type: 'boolean' },
    testnets: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

const store = fileStore(dataDir())
const settings = await loadSettings(store)
const fetchFn = makeFetch(settings.proxy)

const out = (line = '') => console.log(line)
const printJson = (value: unknown) => out(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
const usd = (n: number | undefined) => (n === undefined ? '?' : `$${n.toFixed(2)}`)

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

const adapterFor = (chain: Chain) => evmAdapter(chain, { fetch: fetchFn, rpcUrl: settings.rpc[chain.key] })

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
  const chains = (await lifiChains(fetchFn)).filter((c) => opts.testnets || !c.testnet)
  if (opts.json) return printJson(chains)
  table([['KEY', 'ID', 'NAME', 'COIN'], ...chains.map((c) => [c.key, String(c.id), c.name + (c.testnet ? ' (testnet)' : ''), c.nativeSymbol])])
}

async function balancesCommand(chainQuery: string | undefined): Promise<void> {
  if (!chainQuery) throw new Error('Use: chainer balances <chain>')
  const account = findAccount(await loadKeystore(store), opts.wallet)
  const chain = findChain(await lifiChains(fetchFn), chainQuery)
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

async function buildPlan(args: string[]): Promise<Plan> {
  if (args.length !== 4 && args.length !== 5) throw new Error('Use: <amount> <token> <chain> [<to-token>] <to-chain>, e.g. 100 USDC arbitrum base')
  const [amountText, fromSymbol, fromChainQuery] = args as [string, string, string]
  const toSymbol = args.length === 5 ? args[3]! : fromSymbol
  const toChainQuery = args[args.length - 1]!

  const account = findAccount(await loadKeystore(store), opts.wallet)
  const chains = await lifiChains(fetchFn)
  const fromChain = findChain(chains, fromChainQuery)
  const toChain = findChain(chains, toChainQuery)
  const [from, to] = await Promise.all([lifiToken(fetchFn, fromChain, fromSymbol), lifiToken(fetchFn, toChain, toSymbol)])

  if (!/^\d+(\.\d+)?$/.test(amountText)) throw new Error(`"${amountText}" is not a valid amount`)
  const amount = parseUnits(amountText, from.decimals)
  if (amount === 0n) throw new Error('The amount must be greater than zero')

  const toAddress = opts.to ?? account.addresses.evm
  if (!adapterFor(toChain).validateAddress(toAddress)) throw new Error(`"${toAddress}" is not a valid address on ${toChain.name}`)

  const valueUsd = from.priceUsd === undefined ? undefined : (Number(amount) / 10 ** from.decimals) * from.priceUsd
  if (settings.maxUsdPerTransfer !== null && valueUsd !== undefined && valueUsd > settings.maxUsdPerTransfer) {
    throw new Error(`This transfer is worth about ${usd(valueUsd)}, above your limit of ${usd(settings.maxUsdPerTransfer)} (chainer config set maxUsdPerTransfer <usd|off>)`)
  }
  return { request: { from, to, amount, fromAddress: account.addresses.evm, toAddress, slippage: settings.slippage }, fromChain, toChain, wallet: account.name }
}

async function search(plan: Plan): Promise<{ quotes: Quote[]; provider: ReturnType<typeof lifiProvider> }> {
  const provider = lifiProvider(fetchFn, [plan.fromChain, plan.toChain], settings)
  const { quotes, errors } = await findRoutes(plan.request, [provider], settings, preference())
  if (quotes.length === 0) throw new Error(errors.length ? `No route found. ${errors.join('; ')}` : 'No route found that respects your avoid list.')
  for (const e of errors) console.error(`Note: ${e}`)
  return { quotes, provider }
}

function printQuotes(plan: Plan, quotes: Quote[]): void {
  const { from, to, amount } = plan.request
  out(`${fmt(amount, from)} on ${plan.fromChain.name} -> ${to.symbol} on ${plan.toChain.name}, ranked ${preference()} first`)
  out()
  table([
    ['#', 'VIA', 'YOU RECEIVE', 'AT WORST', 'GAS + FEES', 'NET VALUE', 'TIME'],
    ...quotes.map((q, i) => [String(i + 1), `${q.provider}/${q.tool}`, fmt(q.toAmount, to), fmt(q.toAmountMin, to), usd(q.costUsd), usd(netUsd(q)), duration(q.etaSeconds)]),
  ])
}

async function quoteCommand(args: string[]): Promise<void> {
  const plan = await buildPlan(args)
  const { quotes } = await search(plan)
  if (opts.json) return printJson(quotes.map(({ actions: _, ...q }) => ({ ...q, netUsd: netUsd(q as Quote) })))
  printQuotes(plan, quotes)
}

const stamp = () => new Date().toTimeString().slice(0, 8)

function printOutcome(record: TransferRecord): void {
  if (opts.json) return printJson(record)
  if (record.state === 'done') {
    out(`Done. Received ${record.receivedAmount ? fmt(record.receivedAmount, record.to) : `about ${fmt(record.expectedAmount, record.to)}`} at ${record.toAddress}`)
    if (record.destTxId) out(`Destination transaction: ${record.destTxId}`)
  } else if (record.state === 'failed') {
    out(`Failed: ${record.error}`)
  } else if (record.state === 'signing') {
    out(`Unclear: the app stopped while sending (${record.error ?? 'no error recorded'}).`)
    out(`Check the recent transactions of ${record.fromAddress} before trying again.`)
  } else {
    out(`State: ${record.state}`)
  }
  if (record.state !== 'done') process.exitCode = 1
}

async function sendCommand(args: string[]): Promise<void> {
  const plan = await buildPlan(args)
  const { request } = plan
  const adapter = adapterFor(plan.fromChain)

  const [balance] = await adapter.getBalances(request.fromAddress, [request.from])
  if (balance! < request.amount) {
    const problem = `Not enough ${request.from.symbol} on ${plan.fromChain.name}: the wallet holds ${fmt(balance!, request.from)}`
    if (!opts['dry-run']) throw new Error(problem)
    console.error(`Note: ${problem}`)
  }

  const { quotes, provider } = await search(plan)
  const best = quotes[0]!
  if (!opts.json) {
    printQuotes(plan, quotes)
    out()
    out(`Route:     ${best.provider}/${best.tool}`)
    out(`Recipient: ${request.toAddress}`)
  }
  if (opts['dry-run']) return out('Dry run: nothing was signed or sent.')
  if (!opts.yes && !(await confirm(`Send ${fmt(request.amount, request.from)} over this route?`))) return out('Cancelled.')

  const signer = await unlock(store, plan.wallet, await askPassword())
  const onEvent = (record: TransferRecord, message: string) => {
    if (opts.json) return console.error(JSON.stringify({ id: record.id, state: record.state, message }))
    out(`[${stamp()}] ${message}`)
  }
  process.once('SIGINT', () => {
    console.error('\nStopped watching. If the transaction was submitted it continues on-chain; run "chainer status" to pick it up again.')
    process.exit(130)
  })
  printOutcome(await executeQuote(best, plan.wallet, signer, { store, provider, adapter, onEvent }))
}

// ---- status -------------------------------------------------------------

async function statusCommand(id: string | undefined): Promise<void> {
  const records = await listTransfers(store)
  if (!id) {
    if (opts.json) return printJson(records)
    if (records.length === 0) return out('No transfers yet.')
    return table([
      ['ID', 'STARTED', 'STATE', 'TRANSFER'],
      ...records.map((r) => [r.id.slice(0, 8), r.createdAt.slice(0, 16).replace('T', ' '), r.state, `${fmt(r.amount, r.from)} ${r.from.chainKey} -> ${r.to.symbol} ${r.to.chainKey} via ${r.provider}/${r.tool}`]),
    ])
  }
  const matches = records.filter((r) => r.id.startsWith(id))
  if (matches.length !== 1) throw new Error(matches.length ? `"${id}" matches several transfers; give more characters` : `No transfer with id "${id}"`)
  const record = matches[0]!
  if (record.state !== 'submitted') return printOutcome(record)

  const chains = await lifiChains(fetchFn)
  const fromChain = chains.find((c) => c.key === record.from.chainKey)
  const toChain = chains.find((c) => c.key === record.to.chainKey)
  if (!fromChain || !toChain) throw new Error('The chains of this transfer are no longer listed')
  const provider = lifiProvider(fetchFn, [fromChain, toChain], settings)
  const onEvent = (_: TransferRecord, message: string) => !opts.json && out(`[${stamp()}] ${message}`)
  printOutcome(await trackTransfer(record, { store, provider, adapter: adapterFor(fromChain), onEvent }))
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
    } else if (a === 'proxy') {
      if (b !== 'off' && !/^(socks5?|https?):\/\//.test(b)) throw new Error('proxy must be a socks5:// or http:// URL, or "off" (Tor: socks5://127.0.0.1:9050)')
      next.proxy = b === 'off' ? null : b
    } else throw new Error(`Unknown setting "${a}"`)
  } else if (sub === 'rpc' && a && b) {
    const chain = findChain(await lifiChains(fetchFn), a)
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
    case 'status':
    case 'history':
      return statusCommand(rest[0])
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
