import type { Account } from 'viem'

export type FetchFn = typeof fetch
export type Prefer = 'cheapest' | 'fastest'

/** Chain families; each has one ChainAdapter. More are added per milestone. */
export type ChainFamily = 'evm'

export interface Chain {
  family: ChainFamily
  /** Short unique key, e.g. "arb". */
  key: string
  /** Native chain id (EVM chain id). */
  id: number
  name: string
  nativeSymbol: string
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
export type Action = EvmTxAction

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

export interface BridgeProvider {
  name: string
  traits: ProviderTraits
  getQuotes(request: QuoteRequest, prefer: Prefer): Promise<Quote[]>
  /** Turns a quote into the transactions to sign. Called only when the quote is executed. */
  buildActions(quote: Quote): Promise<Action[]>
  getStatus(txId: string, statusRef: Quote['statusRef']): Promise<TransferStatus>
}

/** Keys able to sign for each chain family. */
export interface Signer {
  evm: Account
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
