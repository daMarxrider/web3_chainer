import type { Account } from 'viem'

export type FetchFn = typeof fetch
export type Prefer = 'cheapest' | 'fastest'

/** Chain families; each has one ChainAdapter. More are added per milestone. */
export type ChainFamily = 'evm' | 'solana' | 'bitcoin'

export interface Chain {
  family: ChainFamily
  /** Short unique key, e.g. "arb". */
  key: string
  /** Native chain id (EVM chain id). For other families the id LI.FI uses, or one made up here for test networks. */
  id: number
  name: string
  nativeSymbol: string
  /** Price of the chain's own coin in USD, when the source of the chain list knows it. Used to price gas. */
  nativePriceUsd?: number
  /** JSON-RPC endpoints (EVM, Solana) or Esplora-compatible REST endpoints (Bitcoin family). */
  rpcUrls: string[]
  /** Multicall3 contract, used to read many balances in one request. */
  multicall?: string
  testnet: boolean
}

export interface Token {
  chainKey: string
  /** Contract address; the zero address means the chain's native coin. */
  address: string
  symbol: string
  decimals: number
  priceUsd?: number
  /** Full name, when the token list gives one. */
  name?: string
  /** LI.FI's token screening: "flagged" tokens are not offered or sent. */
  screening?: 'verified' | 'flagged' | 'unverified'
}

export interface QuoteRequest {
  from: Token
  to: Token
  /** Amount of `from` in its smallest unit. */
  amount: bigint
  fromAddress: string
  toAddress: string
  /** Fraction, e.g. 0.005 for 0.5 %. */
  slippage: number
}

/** A thing to sign and send. Plain data: providers build these, adapters execute them. */
export interface EvmTxAction {
  kind: 'evm-tx'
  chainKey: string
  to: string
  data: string
  value: bigint
  gasLimit?: bigint
  /** ERC-20 allowance that must exist before the transaction is sent. */
  approval?: { token: string; spender: string; amount: bigint }
}
/** A finished Solana transaction (base64, versioned) that still needs the wallet's signature. */
export interface SolanaTxAction {
  kind: 'solana-tx'
  chainKey: string
  transaction: string
}
/** Plain Solana transfer of SOL or an SPL token to a deposit address, with an optional memo. */
export interface SolanaTransferAction {
  kind: 'solana-transfer'
  chainKey: string
  to: string
  /** SPL token mint; absent for SOL. */
  mint?: string
  amount: bigint
  memo?: string
}
/** A PSBT (hex) prepared by a route source; the wallet signs the inputs it owns and broadcasts. */
export interface UtxoPsbtAction {
  kind: 'utxo-psbt'
  chainKey: string
  psbt: string
  /** What the user means to send; the adapter refuses a PSBT that pays anyone else more than this. */
  to: string
  amount: bigint
}
/** Send coins to an address, optionally with an OP_RETURN memo (THORChain, Maya). The adapter picks inputs. */
export interface UtxoSendAction {
  kind: 'utxo-send'
  chainKey: string
  to: string
  amount: bigint
  memo?: string
}
export type Action = EvmTxAction | SolanaTxAction | SolanaTransferAction | UtxoPsbtAction | UtxoSendAction

export interface Quote {
  provider: string
  /** Bridge or exchange the provider would use, e.g. "across". */
  tool: string
  request: QuoteRequest
  toAmount: bigint
  /** Worst case after slippage. */
  toAmountMin: bigint
  toAmountUsd?: number
  /** Gas and fees paid on top of the amount sent (fees already deducted from toAmount are not repeated). */
  costUsd: number
  /** Expected loss from price movement before the swap settles (thin liquidity), in USD. Counts against the route when ranking. */
  riskUsd?: number
  etaSeconds: number
  /** Symbols of every token the route passes through, for the avoid list. */
  viaSymbols: string[]
  /** Provider-specific data needed to build the transaction when the quote is executed. */
  raw: unknown
  /** Opaque data the provider needs later to look up the transfer status. */
  statusRef: Record<string, string | number>
}

export type TransferState = 'pending' | 'done' | 'failed'
export interface TransferStatus {
  state: TransferState
  detail?: string
  receivedAmount?: bigint
  destTxId?: string
}

export interface ProviderTraits {
  /** The service never holds the user's funds. Providers without this are refused. */
  nonCustodial: boolean
  /** Needs an API key, i.e. an account with the service. Off unless the user supplies a key. */
  needsApiKey: boolean
}

/** What the engine hands a self-driving provider (one that runs a multi-step swap itself). */
export interface RunContext {
  signer: Signer
  adapterFor(chainKey: string): ChainAdapter
  /** Progress the provider saved earlier for this transfer; set when resuming. */
  state?: Record<string, unknown>
  /**
   * Writes progress to the journal. A `txId` means money has left (or is about to leave) the
   * wallet and moves the transfer to "submitted", so it can be resumed after a crash. Call it
   * with the id before sending, not after.
   */
  checkpoint(patch: { txId?: string; state?: Record<string, unknown> }): Promise<void>
  say(message: string): void
}

export interface BridgeProvider {
  name: string
  traits: ProviderTraits
  getQuotes(request: QuoteRequest, prefer: Prefer): Promise<Quote[]>
  /** Turns a quote into the transactions to sign. Called only when the quote is executed. */
  buildActions(quote: Quote): Promise<Action[]>
  getStatus(txId: string, statusRef: Quote['statusRef']): Promise<TransferStatus>
  /**
   * Self-driving providers (SDK swaps with several steps over time: open, pay, wait, claim or
   * refund) run the whole transfer here instead of through buildActions and getStatus.
   */
  run?(quote: Quote, ctx: RunContext): Promise<TransferStatus>
  /** Continues a run that stopped after its first checkpoint with a txId; `ctx.state` holds what `run` saved. */
  resume?(ctx: RunContext): Promise<TransferStatus>
}

/**
 * Keys able to sign. `evm` always exists. `seed` (the BIP-39 seed) exists for seed-phrase
 * wallets only; the other families derive their keys from it, so a wallet made from a single
 * imported EVM private key cannot use them.
 */
export interface Signer {
  evm: Account
  seed?: Uint8Array
}

export interface ChainAdapter {
  chain: Chain
  validateAddress(address: string): boolean
  /** Balances in smallest units, in the same order as `tokens`. */
  getBalances(address: string, tokens: Token[]): Promise<bigint[]>
  /** Anything needed before the main transaction (token approvals). */
  prepare(action: Action, signer: Signer, onEvent: (message: string) => void): Promise<void>
  /** Signs and broadcasts; returns the transaction id. */
  send(action: Action, signer: Signer): Promise<string>
  /** Resolves true once confirmed, false if the transaction reverted. */
  waitForConfirmation(txId: string): Promise<boolean>
}

/** Minimal key/value persistence so core runs in Node and in a webview. */
export interface Store {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  keys(prefix: string): Promise<string[]>
}
