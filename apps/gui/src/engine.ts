import {
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
  listPipelines,
  pipelineFromRoute,
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

const withTimeout: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) })

export interface Session {
  walletName: string
  signer: Signer
  account: AccountRecord
}

class Engine {
  readonly store: Store = localStore()
  settings: Settings = defaultSettings
  /** True runs everything on test networks with test funds. */
  testMode = false
  session?: Session
  private chainList?: Promise<Chain[]>

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
    this.session = { walletName: account.name, signer, account }
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
    const chains = await this.chains()
    const fromChain = chains.find((c) => c.key === from.chainKey)!
    const fromAddress = this.ownAddress(fromChain)
    const providers = await this.providers()
    const addressOn = (chainKey: string) => this.ownAddress(chains.find((c) => c.key === chainKey)!)
    const { routes, errors } = await findPipelineRoutes({ from, to, amount, fromAddress, toAddress, slippage: this.settings.slippage }, providers, this.settings, {
      prefer: this.settings.prefer,
      hubs: () => this.hubs(),
      maxHops: this.settings.maxHops,
      addressOn,
    })
    return { routes, errors }
  }

  /** Runs that were started and have not finished (the app was closed, crashed or a leg failed). */
  async unfinished(): Promise<PipelineRecord[]> {
    return (await listPipelines(this.runStore)).filter((r) => r.state !== 'done' && r.wallet === this.session?.walletName).reverse()
  }

  /** Continues a run from where its journal says it stopped. */
  async resume(record: PipelineRecord, onEvent: (record: PipelineRecord, legIndex: number, message: string) => void): Promise<PipelineRecord> {
    const session = this.requireSession()
    const chains = await this.chains()
    for (const leg of record.legs) {
      const chain = chains.find((c) => c.key === leg.from.chainKey)
      if (chain && chainAddress(session.signer, chain) !== (leg.fromAddress ?? record.fromAddress)) throw new Error('The wallet no longer matches the address this run was created for')
    }
    record.state = 'running'
    return runPipeline(record, {
      store: this.runStore,
      settings: this.settings,
      signer: session.signer,
      providers: await this.providers(),
      adapterFor: (key) => this.adapterFor(chains.find((c) => c.key === key)!),
      onEvent,
    })
  }

  /** Starts the chosen route as a run and reports every step; resolves with the finished record. */
  async run(route: Route, geoAccepted: string[], onEvent: (record: PipelineRecord, legIndex: number, message: string) => void): Promise<PipelineRecord> {
    const session = this.requireSession()
    const chains = await this.chains()
    const record = pipelineFromRoute(route, session.walletName, geoAccepted)
    for (const leg of record.legs) {
      const chain = chains.find((c) => c.key === leg.from.chainKey)
      if (chain && chainAddress(session.signer, chain) !== (leg.fromAddress ?? record.fromAddress)) throw new Error('The wallet no longer matches the address this route was made for')
    }
    return runPipeline(record, {
      store: this.runStore,
      settings: this.settings,
      signer: session.signer,
      providers: await this.providers(),
      adapterFor: (key) => this.adapterFor(chains.find((c) => c.key === key)!),
      onEvent,
    })
  }
}

export const engine = new Engine()
