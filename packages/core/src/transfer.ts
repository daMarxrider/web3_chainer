import type { BridgeProvider, ChainAdapter, Quote, RunContext, Signer, Store, Token, TransferStatus } from './types.ts'

/**
 * Journal entry for one transfer. Written before and after every on-chain step so a crash
 * never leaves funds in flight without a record.
 *
 * created -> signing -> submitted -> done | failed
 * "signing" without a txId means the app stopped while broadcasting: the transaction may or
 * may not have gone out, so it is never re-sent automatically.
 */
export interface TransferRecord {
  id: string
  createdAt: string
  wallet: string
  provider: string
  tool: string
  from: Token
  to: Token
  amount: string
  expectedAmount: string
  fromAddress: string
  toAddress: string
  statusRef: Quote['statusRef']
  state: 'created' | 'signing' | 'submitted' | 'done' | 'failed'
  txId?: string
  destTxId?: string
  receivedAmount?: string
  error?: string
  /** What a self-driving provider saved so it can resume (see RunContext). */
  providerState?: Record<string, unknown>
}

export type TransferEvent = (record: TransferRecord, message: string) => void

const PREFIX = 'journal/'
const save = (store: Store, record: TransferRecord) => store.set(`${PREFIX}${record.id}.json`, JSON.stringify(record, null, 2))

export async function getTransfer(store: Store, id: string): Promise<TransferRecord | null> {
  const raw = await store.get(`${PREFIX}${id}.json`)
  return raw ? (JSON.parse(raw) as TransferRecord) : null
}

export async function listTransfers(store: Store): Promise<TransferRecord[]> {
  const keys = await store.keys(PREFIX)
  const records = await Promise.all(keys.map(async (k) => JSON.parse((await store.get(k))!) as TransferRecord))
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export interface TransferDeps {
  store: Store
  provider: BridgeProvider
  adapter: ChainAdapter
  onEvent: TransferEvent
  /** Milliseconds between bridge status checks. */
  pollMs?: number
  /** Journal id chosen by the caller, so it can be recorded before the transfer starts. */
  id?: string
  /** Needed by self-driving providers, which sign several steps and may touch other chains. */
  signer?: Signer
  adapterFor?(chainKey: string): ChainAdapter
}

function runContext(record: TransferRecord, deps: TransferDeps): RunContext {
  if (!deps.signer || !deps.adapterFor) throw new Error(`${record.provider} runs the whole transfer itself and needs the wallet signer and chain access`)
  return {
    signer: deps.signer,
    adapterFor: deps.adapterFor,
    state: record.providerState,
    say: (message) => deps.onEvent(record, message),
    async checkpoint(patch) {
      if (patch.state) record.providerState = { ...record.providerState, ...patch.state }
      if (patch.txId) {
        record.txId = patch.txId
        record.state = 'submitted'
      }
      await save(deps.store, record)
    },
  }
}

/** Writes the end state of a self-driving run into the record. */
async function finishRun(record: TransferRecord, status: TransferStatus, store: Store): Promise<TransferRecord> {
  record.state = status.state === 'pending' ? 'submitted' : status.state
  record.destTxId = status.destTxId
  record.receivedAmount = status.receivedAmount?.toString()
  if (status.state === 'failed') record.error = status.detail ?? 'The swap failed'
  await save(store, record)
  return record
}

/** Signs and sends a quote's transaction, then follows it until the funds arrive. */
export async function executeQuote(quote: Quote, wallet: string, signer: Signer, deps: TransferDeps): Promise<TransferRecord> {
  const { store, adapter, onEvent } = deps
  const record: TransferRecord = {
    id: deps.id ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    wallet,
    provider: quote.provider,
    tool: quote.tool,
    from: quote.request.from,
    to: quote.request.to,
    amount: quote.request.amount.toString(),
    expectedAmount: quote.toAmount.toString(),
    fromAddress: quote.request.fromAddress,
    toAddress: quote.request.toAddress,
    statusRef: quote.statusRef,
    state: 'created',
  }
  await save(store, record)

  if (deps.provider.run) {
    try {
      return await finishRun(record, await deps.provider.run(quote, runContext(record, deps)), store)
    } catch (err) {
      // Before the first checkpoint with a txId nothing left the wallet; after it the run can be resumed.
      if (record.state === 'created') record.state = 'failed'
      record.error = (err as Error).message
      await save(store, record)
      throw err
    }
  }

  try {
    for (const action of await deps.provider.buildActions(quote)) {
      await adapter.prepare(action, signer, (message) => onEvent(record, message))
      record.state = 'signing'
      await save(store, record)
      onEvent(record, 'Signing and sending the transaction')
      record.txId = await adapter.send(action, signer)
      record.state = 'submitted'
      await save(store, record)
      onEvent(record, `Submitted: ${record.txId}`)
    }
  } catch (err) {
    // A failure before signing means nothing moved. A failure while sending is ambiguous
    // (the node may have accepted it before the error), so the record stays "signing".
    if (record.state !== 'signing') record.state = 'failed'
    record.error = (err as Error).message
    await save(store, record)
    throw err
  }
  return trackTransfer(record, deps)
}

/** Follows a submitted transfer to its end. Safe to call again after a restart. */
export async function trackTransfer(record: TransferRecord, deps: TransferDeps): Promise<TransferRecord> {
  const { store, provider, adapter, onEvent, pollMs = 10_000 } = deps
  if (record.state !== 'submitted' || !record.txId) return record

  if (provider.resume && record.providerState) {
    onEvent(record, 'Resuming the swap')
    try {
      return await finishRun(record, await provider.resume(runContext(record, deps)), store)
    } catch (err) {
      record.error = (err as Error).message
      await save(store, record)
      throw err
    }
  }

  onEvent(record, 'Waiting for confirmation on the source chain')
  if (!(await adapter.waitForConfirmation(record.txId))) {
    record.state = 'failed'
    record.error = 'The transaction reverted on the source chain; the funds did not leave the wallet'
    await save(store, record)
    return record
  }
  onEvent(record, 'Confirmed; waiting for the funds to arrive')

  let lastDetail: string | undefined
  for (;;) {
    const status = await provider.getStatus(record.txId, record.statusRef)
    if (status.state === 'pending') {
      if (status.detail && status.detail !== lastDetail) onEvent(record, status.detail)
      lastDetail = status.detail
      await new Promise((r) => setTimeout(r, pollMs))
      continue
    }
    record.state = status.state
    record.destTxId = status.destTxId
    record.receivedAmount = status.receivedAmount?.toString()
    if (status.state === 'failed') record.error = status.detail ?? 'The bridge reported a failure'
    await save(store, record)
    return record
  }
}
