import {
  loadTokenList,
  TokenIndex,
  BUILTIN_CHAINS,
  bitcoinAdapter,
  cctpProvider,
  chainAddress,
  evmAdapter,
  findChain,
  findPipelineRoutes,
  lifiChains,
  lifiProvider,
  lifiToken,
  lifiTokens,
  loadKeystore,
  loadSettings,
  mayaProvider,
  TransitPool,
  addAddress,
  chooseSaved,
  estimateGasUsd,
  persistTransit,
  planGasTopUp,
  stopOverUsd,
  stopOvers,
  transitAllowed,
  type StopOver,
  listPipelines,
  listRoutes,
  listSchedules,
  loadRoute,
  geoKeys,
  newPipeline,
  parseUnits,
  pipelineFromRoute,
  planSweep,
  removeAddress,
  removeRoute,
  removeSchedule,
  resolveRecipient,
  saveRoute,
  saveSchedule,
  isNative,
  type SavedRoute,
  type SavedSweep,
  type SavedTransfer,
  type Schedule,
  type SweepPlan,
  type PipelineLeg,
  runPipeline,
  saveSettings,
  solanaAdapter,
  thorchainProvider,
  unlock,
  type AccountRecord,
  type BridgeProvider,
  type Chain,
  type ChainAdapter,
  type PipelineRecord,
  type Route,
  type Settings,
  type Signer,
  type Store,
  type Token,
  addressSlot,
  defaultSettings,
} from '@chainer/core'

/** Test networks standing in for each main network in test mode (same table as the CLI). */
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

/** localStorage with the same shape as the CLI's file store; test runs live under their own prefix. */
export function localStore(prefix = 'chainer/'): Store {
  const all = () => Object.keys(localStorage).filter((k) => k.startsWith(prefix))
  return {
    async get(key) {
      return localStorage.getItem(prefix + key)
    },
    async set(key, value) {
      localStorage.setItem(prefix + key, value)
    },
    async keys(p) {
      return all()
        .map((k) => k.slice(prefix.length))
        .filter((k) => k.startsWith(p))
    },
  }
}

/**
 * Network requests. In the browser this is fetch; in the Tauri shell it is the HTTP plugin,
 * because the webview does not let the app call other origins directly.
 */
type TauriFetch = typeof fetch
let tauriFetch: Promise<TauriFetch> | undefined
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const platformFetch: typeof fetch = inTauri ? async (input, init) => (await (tauriFetch ??= import('@tauri-apps/plugin-http').then((m) => m.fetch as TauriFetch)))(input, init) : (input, init) => fetch(input, init)

const withTimeout: typeof fetch = (input, init) => platformFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) })

export interface Session {
  walletName: string
  signer: Signer
  account: AccountRecord
  /** Kept in memory while unlocked: transit wallets are stored encrypted under it and unlocked with it. */
  password: string
}

/** A small transfer that puts gas on a chain the main route stops on, sent before the route starts. */
export interface StopTopUp {
  stop: StopOver
  route: Route
  usd: number
}

/** The extra transfers around a main route: gas for its stop-over chains (before) and for the recipient (after). */
export interface GasPlan {
  stops: StopTopUp[]
  topUp?: Route
  /** Why no top-up was planned, when it was wanted but not possible or not needed. */
  topUpNote?: string
}

type RunEvent = (record: PipelineRecord, legIndex: number, message: string) => void

class Engine {
  readonly store: Store = localStore()
  settings: Settings = defaultSettings
  /** True runs everything on test networks with test funds. */
  testMode = false
  session?: Session
  private chainList?: Promise<Chain[]>
  /** Transit wallets made for the last route search; stored when a route that uses them runs. */
  private pool?: TransitPool

  /** Journal and runs of test mode are kept apart from real ones. */
  get runStore(): Store {
    if (!this.testMode) return this.store
    const s = this.store
    return { get: (k) => s.get(`testnet/${k}`), set: (k, v) => s.set(`testnet/${k}`, v), keys: async (p) => (await s.keys(`testnet/${p}`)).map((k) => k.slice('testnet/'.length)) }
  }

  async load(): Promise<void> {
    this.settings = await loadSettings(this.store)
  }
  async saveSettings(next: Settings): Promise<void> {
    this.settings = next
    await saveSettings(this.store, next)
  }

  async accounts(): Promise<AccountRecord[]> {
    return (await loadKeystore(this.store)).accounts
  }

  async unlock(walletName: string | undefined, password: string): Promise<Session> {
    const accounts = await this.accounts()
    const account = walletName ? accounts.find((a) => a.name === walletName) : accounts[0]
    if (!account) throw new Error('No wallet found')
    const signer = await unlock(this.store, account.name, password)
    this.session = { walletName: account.name, signer, account, password }
    return this.session
  }
  lock(): void {
    this.session = undefined
  }

  chains(): Promise<Chain[]> {
    return (this.chainList ??= lifiChains(withTimeout).then((found) => [...found, ...BUILTIN_CHAINS.filter((t) => !found.some((c) => c.key === t.key))]))
  }

  /** Finds a chain by key, id or name; in test mode a main network becomes its test network. */
  async resolveChain(query: string): Promise<Chain> {
    const chains = await this.chains()
    const chain = findChain(chains, query)
    if (!this.testMode || chain.testnet) return chain
    const test = chains.find((c) => c.key === TESTNET_OF[chain.key])
    if (!test) throw new Error(`${chain.name} has no test network here, so it cannot be tested with test funds`)
    return test
  }

  /** Chains shown in pickers: main networks, or test networks in test mode. */
  async pickerChains(): Promise<Chain[]> {
    return (await this.chains()).filter((c) => c.testnet === this.testMode).sort((a, b) => a.name.localeCompare(b.name))
  }

  adapterFor(chain: Chain): ChainAdapter {
    const o = { fetch: withTimeout, rpcUrl: this.settings.rpc[chain.key], blockcypher: this.settings.blockcypher }
    return chain.family === 'solana' ? solanaAdapter(chain, o) : chain.family === 'bitcoin' ? bitcoinAdapter(chain, o) : evmAdapter(chain, o)
  }

  /** The wallet's address on a chain. */
  ownAddress(chain: Chain): string {
    const s = this.requireSession()
    const address = s.account.addresses[addressSlot(chain)]
    if (!address) throw new Error(`Wallet "${s.walletName}" has no address on ${chain.name}`)
    return address
  }

  requireSession(): Session {
    if (!this.session) throw new Error('The wallet is locked')
    return this.session
  }

  async providers(): Promise<BridgeProvider[]> {
    const chains = await this.chains()
    const all = [lifiProvider(withTimeout, chains, this.settings), cctpProvider(withTimeout, chains), thorchainProvider(withTimeout, chains), mayaProvider(withTimeout, chains)]
    return all.filter((p) => !this.settings.disabledProviders.includes(p.name))
  }

  private tokenIndexLoad?: Promise<TokenIndex>
  /** The curated token list (cached for a day), for telling known tokens from look-alikes. Without it, only LI.FI's screening is used. */
  tokenIndex(): Promise<TokenIndex> {
    return (this.tokenIndexLoad ??= loadTokenList(withTimeout, this.store).then((list) => new TokenIndex(list)))
  }
  tokens(chain: Chain): Promise<Token[]> {
    return lifiTokens(withTimeout, chain)
  }
  token(chain: Chain, symbolOrAddress: string): Promise<Token> {
    return lifiToken(withTimeout, chain, symbolOrAddress)
  }

  async balances(chain: Chain): Promise<{ token: Token; balance: bigint; usd?: number }[]> {
    const tokens = await this.tokens(chain)
    const address = this.ownAddress(chain)
    const balances = await this.adapterFor(chain).getBalances(address, tokens)
    return tokens
      .map((token, i) => ({ token, balance: balances[i]!, usd: token.priceUsd === undefined ? undefined : (Number(balances[i]!) / 10 ** token.decimals) * token.priceUsd }))
      .filter((h) => h.balance > 0n)
      .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
  }

  private async hubs(): Promise<Token[]> {
    const found = await Promise.allSettled(
      HUBS.map(async ([chainKey, symbol]) => {
        const chain = await this.resolveChain(chainKey)
        return lifiToken(withTimeout, chain, symbol)
      }),
    )
    return found.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  }

  /** Ranked routes for a transfer, direct or through other chains. */
  async findRoutes(from: Token, to: Token, amount: bigint, toAddress: string): Promise<{ routes: Route[]; errors: string[] }> {
    const session = this.requireSession()
    const chains = await this.chains()
    const fromChain = chains.find((c) => c.key === from.chainKey)!
    const fromAddress = this.ownAddress(fromChain)
    const providers = await this.providers()
    // A wallet with no address on a stop-over chain (a single private key) gets a transit wallet for it.
    const pool = (this.pool = new TransitPool(await this.accounts()))
    const addressOn = (chainKey: string) => {
      const chain = chains.find((c) => c.key === chainKey)!
      return session.account.addresses[addressSlot(chain)] ?? pool.addressOn(chain)
    }
    const found = await findPipelineRoutes({ from, to, amount, fromAddress, toAddress, slippage: this.settings.slippage }, providers, this.settings, {
      prefer: this.settings.prefer,
      hubs: () => this.hubs(),
      maxHops: this.settings.maxHops,
      addressOn,
    })
    const routes = found.routes.filter((r) => transitAllowed(r, pool, this.settings.gasTopUp.mode !== 'off'))
    if (routes.length === 0 && found.routes.length > 0) throw new Error("The only routes stop on a chain where this wallet has no address, with a token other than that chain's own coin. Import a seed phrase wallet, or choose another route.")
    return { routes, errors: found.errors }
  }

  // ---- gas: for stop-over chains and for the recipient ----

  /**
   * Gas for the chains a route stops on. A stop-over holding a token other than the chain's coin
   * needs some of that coin to pay for the next leg, so a small transfer from the source wallet goes
   * there first, sized from the next leg's own quoted cost (times the multiplier, or the fixed value).
   */
  private async stopOverTopUps(route: Route, sourceBalance: bigint, mainAmount: bigint): Promise<StopTopUp[]> {
    const setting = this.settings.gasTopUp
    if (setting.mode === 'off') return []
    const chains = await this.chains()
    const first = route.legs[0]!.request
    const found: StopTopUp[] = []
    let spent = mainAmount
    for (const stop of stopOvers(route)) {
      const chain = chains.find((c) => c.key === stop.chainKey)!
      const native = await lifiToken(withTimeout, chain, chain.nativeSymbol)
      const [have] = await this.adapterFor(chain).getBalances(stop.address, [native])
      if (have! > 0n) continue
      const estimated = stop.nextCostUsd > 0 || setting.mode !== 'multiplier' ? undefined : await estimateGasUsd(chain, withTimeout)
      const { usd, why } = stopOverUsd(setting, stop, estimated)
      if (!usd) throw new Error(`Cannot send gas ahead to ${chain.name}: ${why ?? 'no amount'}`)
      const price = first.from.priceUsd
      if (!price) throw new Error(`Cannot send gas ahead to ${chain.name}: the price of ${first.from.symbol} is unknown`)
      const amount = BigInt(Math.ceil((usd / price) * 10 ** first.from.decimals))
      if (spent + amount > sourceBalance) throw new Error(`The wallet cannot pay the gas for ${chain.name} (about ${usd.toFixed(2)} USD) on top of the transfer; send a smaller amount, or turn the gas top-up off in Settings`)
      spent += amount
      // The transfer to the stop-over address has to be one leg, or it would need stop-overs of its own.
      const keep = this.pool
      let candidates: Route[]
      try {
        candidates = (await this.findRoutes(first.from, native, amount, stop.address)).routes
      } catch (err) {
        throw new Error(`Cannot send gas ahead to ${chain.name}: ${(err as Error).message}. Turn the gas top-up off in Settings or get some ${chain.nativeSymbol} there first.`)
      } finally {
        this.pool = keep
      }
      const direct = candidates.find((r) => r.legs.length === 1)
      if (!direct) throw new Error(`No direct route to send gas ahead to ${chain.name}; turn the gas top-up off in Settings or use a seed phrase wallet`)
      found.push({ stop, route: direct, usd })
    }
    return found
  }

  /** The extra transfer that gives a recipient with no gas some of the destination coin, if the setting asks for one. */
  private async recipientTopUp(route: Route, mainAmount: bigint, sourceBalance: bigint): Promise<{ route?: Route; note?: string }> {
    const setting = this.settings.gasTopUp
    if (setting.mode === 'off') return {}
    const chains = await this.chains()
    const first = route.legs[0]!.request
    const last = route.legs.at(-1)!.request
    const toChain = chains.find((c) => c.key === last.to.chainKey)!
    const destNative = await lifiToken(withTimeout, toChain, toChain.nativeSymbol)
    const [have] = await this.adapterFor(toChain).getBalances(last.toAddress, [destNative])
    const estimatedGasUsd = setting.mode === 'multiplier' ? await estimateGasUsd(toChain, withTimeout) : undefined
    const { topUp, why } = planGasTopUp(setting, { source: first.from, destination: last.to, destNative, destNativeBalance: have!, mainAmount, sourceBalance, estimatedGasUsd })
    if (!topUp) return { note: why }
    const keep = this.pool
    try {
      const routes = (await this.findRoutes(first.from, destNative, topUp.amount, last.toAddress)).routes
      return { route: routes[0], note: routes[0] ? undefined : 'no route for it' }
    } catch (err) {
      return { note: `no route for it (${(err as Error).message})` }
    } finally {
      this.pool = keep
    }
  }

  /** Everything extra that a route needs: gas for its stop-over chains, and optionally a top-up for the recipient. */
  async planGas(route: Route, mainAmount: bigint, sourceBalance: bigint, options: { recipientTopUp?: boolean } = { recipientTopUp: true }): Promise<GasPlan> {
    const stops = await this.stopOverTopUps(route, sourceBalance, mainAmount)
    const spentOnStops = stops.reduce((sum, t) => sum + t.route.legs[0]!.request.amount, 0n)
    if (!options.recipientTopUp) return { stops }
    const top = await this.recipientTopUp(route, mainAmount, sourceBalance - spentOnStops)
    return { stops, topUp: top.route, topUpNote: top.note }
  }

  /** Every route the plan may use, for the location confirmation. */
  gasRoutes(plan: GasPlan): Route[] {
    return [...plan.stops.map((t) => t.route), ...(plan.topUp ? [plan.topUp] : [])]
  }

  /** Runs that were started and have not finished (the app was closed, crashed or a leg failed). */
  async unfinished(): Promise<PipelineRecord[]> {
    return (await listPipelines(this.runStore)).filter((r) => r.state !== 'done' && r.wallet === this.session?.walletName).reverse()
  }

  /** Checks the wallet matches the run, then runs it; used by new runs and resumed ones. */
  private async execute(record: PipelineRecord, onEvent: (record: PipelineRecord, legIndex: number, message: string) => void): Promise<PipelineRecord> {
    const session = this.requireSession()
    const chains = await this.chains()
    // Legs that start on a stop-over chain are signed by that chain's transit wallet.
    const others = new Map<string, Signer>()
    for (const name of new Set(record.legs.flatMap((l) => (l.wallet ? [l.wallet] : [])))) others.set(name, await unlock(this.store, name, session.password))
    for (const leg of record.legs) {
      const chain = chains.find((c) => c.key === leg.from.chainKey)
      const legSigner = leg.wallet ? others.get(leg.wallet)! : session.signer
      if (chain && chainAddress(legSigner, chain) !== (leg.fromAddress ?? record.fromAddress)) throw new Error('The wallet no longer matches the address this run was created for')
    }
    return runPipeline(record, {
      store: this.runStore,
      settings: this.settings,
      signer: session.signer,
      signerFor: (name) => others.get(name)!,
      providers: await this.providers(),
      adapterFor: (key) => this.adapterFor(chains.find((c) => c.key === key)!),
      onEvent,
    })
  }

  /** Continues a run from where its journal says it stopped. */
  async resume(record: PipelineRecord, onEvent: (record: PipelineRecord, legIndex: number, message: string) => void): Promise<PipelineRecord> {
    record.state = 'running'
    return this.execute(record, onEvent)
  }

  /** Starts the chosen route as a run and reports every step; resolves with the finished record. */
  async run(route: Route, geoAccepted: string[], onEvent: RunEvent, options: { wholeBalance?: boolean } = {}): Promise<PipelineRecord> {
    const session = this.requireSession()
    // Transit wallets the route passes through are stored (encrypted) before anything is sent to them.
    const walletOf = this.pool ? await persistTransit(this.store, this.pool, route, async () => session.password) : undefined
    const record = pipelineFromRoute(route, session.walletName, geoAccepted, walletOf)
    if (options.wholeBalance) record.legs[0]!.amount = 'all'
    return this.execute(record, onEvent)
  }

  /** The gas transfers of a plan are only allowed to use restricted services the user confirmed. */
  private checkGeo(plan: GasPlan, accepted: string[]): void {
    if (this.testMode) return
    const needed = [...new Set(this.gasRoutes(plan).flatMap((r) => geoKeys(r.legs)))]
    const missing = needed.filter((k) => !accepted.includes(k))
    if (missing.length) throw new Error(`The gas transfers would use a restricted service that was not confirmed (${missing.join(', ')}); nothing was sent`)
  }

  /** Runs the plan's gas transfers first; the main route never starts if one of them fails. */
  private async runStops(plan: GasPlan, geo: string[], onEvent: RunEvent): Promise<void> {
    this.checkGeo(plan, geo)
    for (const t of plan.stops) {
      const done = await this.run(t.route, geo, (r, i, m) => onEvent(r, i, `Gas for ${t.stop.chainKey}: ${m}`))
      if (done.state !== 'done') throw new Error(`The gas for ${t.stop.chainKey} did not arrive, so the main transfer was not started`)
    }
  }

  /** The recipient's gas top-up runs after the main transfer and never undoes or hides it. */
  private async runTopUp(plan: GasPlan, geo: string[], onEvent: RunEvent, main: PipelineRecord): Promise<void> {
    if (!plan.topUp || main.state !== 'done') return
    try {
      await this.run(plan.topUp, geo, (r, i, m) => onEvent(r, i, `Gas top-up: ${m}`))
    } catch (err) {
      onEvent(main, main.legs.length - 1, `The gas top-up stopped: ${(err as Error).message}`)
    }
  }

  /** Runs a route together with the gas transfers planned for it (see planGas). */
  async runWithGas(route: Route, geoAccepted: string[], onEvent: RunEvent, plan: GasPlan, options: { wholeBalance?: boolean } = {}): Promise<PipelineRecord> {
    await this.runStops(plan, geoAccepted, onEvent)
    const main = await this.run(route, geoAccepted, onEvent, options)
    await this.runTopUp(plan, geoAccepted, onEvent, main)
    return main
  }

  /**
   * Like runWithGas, but the stop-over gas is worked out now, at run time (sweeps, schedules): the wallet
   * balance is read here, and the recipient top-up is left out. Never starts when the gas cannot be arranged.
   */
  async runAuto(route: Route, geoAccepted: string[], onEvent: RunEvent, options: { wholeBalance?: boolean } = {}): Promise<PipelineRecord> {
    const first = route.legs[0]!.request
    const chain = (await this.chains()).find((c) => c.key === first.from.chainKey)!
    const [balance] = await this.adapterFor(chain).getBalances(first.fromAddress, [first.from])
    const plan = await this.planGas(route, first.amount, balance!, { recipientTopUp: false })
    return this.runWithGas(route, geoAccepted, onEvent, plan, options)
  }

  /** Runs a hand-written list of legs; each leg takes the best route when it starts. */
  async runPlan(legs: Omit<PipelineLeg, 'state'>[], geoAccepted: string[], onEvent: RunEvent, plan?: GasPlan): Promise<PipelineRecord> {
    const session = this.requireSession()
    if (plan) await this.runStops(plan, geoAccepted, onEvent)
    const record = newPipeline(session.walletName, legs[0]!.fromAddress!, legs, geoAccepted)
    const main = await this.execute(record, onEvent)
    if (plan) await this.runTopUp(plan, geoAccepted, onEvent, main)
    return main
  }

  /** Gas for a hand-written plan: stop-overs and the last chain, sized from the node's estimate because the legs are not quoted yet. Needs a fixed first amount. */
  async planGasForLegs(legs: Omit<PipelineLeg, 'state'>[]): Promise<GasPlan> {
    const first = legs[0]!
    if (first.amount === 'all' || legs.length < 1) return { stops: [] }
    const chains = await this.chains()
    const fromChain = chains.find((c) => c.key === first.from.chainKey)!
    const [balance] = await this.adapterFor(fromChain).getBalances(first.fromAddress!, [first.from])
    const pseudo = {
      legs: legs.map((l) => ({
        request: { from: l.from, to: l.to, amount: l.amount === 'all' ? 0n : BigInt(l.amount), fromAddress: l.fromAddress!, toAddress: l.toAddress, slippage: this.settings.slippage },
        costUsd: 0,
      })),
    } as unknown as Route
    return this.planGas(pseudo, BigInt(first.amount), balance!, { recipientTopUp: true })
  }

  // ---- tokens and addresses by name ----

  /** "USDC@arbitrum": resolved on the current network mode. */
  async resolveSpec(spec: string): Promise<{ chain: Chain; token: Token }> {
    const [symbol, chainQuery] = spec.split('@')
    if (!symbol || !chainQuery) throw new Error(`"${spec}" should look like TOKEN@chain`)
    const chain = await this.resolveChain(chainQuery)
    return { chain, token: await lifiToken(withTimeout, chain, symbol) }
  }

  /** The recipient for a destination chain: the wallet's own address, or an address book label or address. */
  recipientOn(chain: Chain, typed?: string): string {
    const own = this.ownAddress(chain)
    const to = typed?.trim() ? resolveRecipient(this.settings, typed.trim(), chain.key) : own
    if (!this.adapterFor(chain).validateAddress(to)) throw new Error(`"${to}" is not a valid address on ${chain.name}`)
    return to
  }

  async addressBook(): Promise<Settings['addressBook']> {
    return this.settings.addressBook
  }
  async addAddress(label: string, chainKey: string, address: string): Promise<void> {
    const chain = (await this.chains()).find((c) => c.key === chainKey)!
    await this.saveSettings(addAddress(this.settings, { label, chainKey, address }, (a) => this.adapterFor(chain).validateAddress(a)))
  }
  async removeAddress(label: string, chainKey?: string): Promise<void> {
    await this.saveSettings(removeAddress(this.settings, label, chainKey))
  }

  // ---- history ----

  async history(): Promise<PipelineRecord[]> {
    return (await listPipelines(this.runStore)).reverse()
  }

  // ---- sweep ----

  /** Plans moving the chosen tokens of one chain to another, one transfer per token. */
  async planSweep(fromChain: Chain, toChain: Chain, symbols: string[] | undefined, targetSymbol: string | undefined, recipient?: string): Promise<{ plan: SweepPlan; toAddress: string }> {
    const toAddress = this.recipientOn(toChain, recipient)
    const wanted = symbols?.map((x) => x.toLowerCase())
    const index = await this.tokenIndex()
    // Tokens LI.FI's screening flags (scam airdrops, mostly) are never swept.
    const sourceTokens = (await this.tokens(fromChain)).filter((t) => t.screening !== 'flagged' && (!wanted || wanted.includes(t.symbol.toLowerCase())))
    const balances = await this.adapterFor(fromChain).getBalances(this.ownAddress(fromChain), sourceTokens)
    const holdings = sourceTokens.map((token, i) => ({ token, balance: balances[i]! }))
    const order = { listed: 0, screened: 1, unknown: 2, flagged: 3 } as const
    // Same symbol on the destination: the best-trusted one, so a look-alike with the same symbol is never picked.
    const destTokens = (await this.tokens(toChain)).filter((d) => d.screening !== 'flagged').sort((a, b) => order[index.trust(a, toChain)] - order[index.trust(b, toChain)])
    const chosen = targetSymbol ? await lifiToken(withTimeout, toChain, targetSymbol) : undefined
    if (chosen?.screening === 'flagged') throw new Error(`${chosen.symbol} on ${toChain.name} is flagged by LI.FI’s token screening as a likely scam`)
    const target = (t: Token): Token | undefined => chosen ?? destTokens.find((d) => (isNative(t) ? isNative(d) : d.symbol.toLowerCase() === t.symbol.toLowerCase()))
    const plan = await planSweep({
      holdings,
      target,
      // On chains like Arc the gas coin is also a token; it must keep some back like the native coin does.
      isGasCoin: (t) => isNative(t) || t.symbol.toLowerCase() === fromChain.nativeSymbol.toLowerCase(),
      findRoute: async (from, to, amount) => (await this.findRoutes(from, to, amount, toAddress)).routes[0],
    })
    return { plan, toAddress }
  }

  // ---- saved routes and schedules ----

  async savedRoutes(): Promise<SavedRoute[]> {
    return listRoutes(this.store)
  }
  async saveRoute(route: SavedRoute): Promise<void> {
    await saveRoute(this.store, route)
  }
  async removeRoute(name: string): Promise<void> {
    await removeRoute(this.store, name)
  }
  async loadRoute(name: string): Promise<SavedRoute> {
    return loadRoute(this.store, name)
  }

  /** Quotes a saved transfer again along its saved path (or the best route if it allows that) and checks its minimum. */
  async prepareSaved(saved: SavedTransfer) {
    const [a, b] = await Promise.all([this.resolveSpec(saved.from), this.resolveSpec(saved.to)])
    const toAddress = this.recipientOn(b.chain, saved.recipient)
    const [balance] = await this.adapterFor(a.chain).getBalances(this.ownAddress(a.chain), [a.token])
    const amount = saved.amount === 'all' ? balance! : BigInt(saved.amount)
    if (amount <= 0n || amount > balance!) throw new Error(`The wallet holds ${balance} (smallest units) of ${a.token.symbol} on ${a.chain.name}, not enough for this saved route`)
    const { routes, errors } = await this.findRoutes(a.token, b.token, amount, toAddress)
    if (routes.length === 0) throw new Error(`No route found${errors.length ? `: ${errors.join('; ')}` : ''}`)
    const choice = chooseSaved(saved, routes)
    return { ...choice, from: a.token, to: b.token, fromChain: a.chain, toChain: b.chain, amount, balance: balance!, toAddress, wholeBalance: saved.amount === 'all' }
  }

  async schedules(): Promise<Schedule[]> {
    return listSchedules(this.store)
  }
  async saveSchedule(s: Schedule): Promise<void> {
    await saveSchedule(this.store, s)
  }
  async removeSchedule(id: string): Promise<void> {
    await removeSchedule(this.store, id)
  }

  /** Parses an amount the way the forms do. */
  parseAmount(text: string, token: Token): bigint {
    if (!/^\d+(\.\d+)?$/.test(text.trim())) throw new Error(`"${text}" is not a valid amount`)
    const v = parseUnits(text.trim(), token.decimals)
    if (v === 0n) throw new Error('The amount must be greater than zero')
    return v
  }
}

export const engine = new Engine()
