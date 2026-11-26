import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base58 } from '@scure/base'
import { mnemonicToSeedSync } from '@scure/bip39'
import { getBase64Encoder, getTransactionDecoder } from '@solana/kit'
import { mnemonicToAccount } from 'viem/accounts'
import { BUILTIN_CHAINS, solanaAdapter, type Chain, type Signer, type Token } from '../src/index.ts'

// ---- fixtures ----

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const seedSigner: Signer = { evm: mnemonicToAccount(MNEMONIC), seed: mnemonicToSeedSync(MNEMONIC) }
const keyOnlySigner: Signer = { evm: mnemonicToAccount(MNEMONIC) }
const devnet = BUILTIN_CHAINS.find((c) => c.key === 'sold')!
const twoNodes: Chain = { ...devnet, rpcUrls: ['https://first.node', 'https://second.node'] }
const OWNER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PYUSD_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const TOKEN_CLASSIC = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const sol: Token = { chainKey: 'sold', address: '11111111111111111111111111111111', symbol: 'SOL', decimals: 9 }
const usdc: Token = { chainKey: 'sold', address: USDC_MINT, symbol: 'USDC', decimals: 6 }
const pyusd: Token = { chainKey: 'sold', address: PYUSD_MINT, symbol: 'PYUSD', decimals: 6 }

type Reply = { result?: unknown; error?: { message: string }; status?: number; networkError?: boolean }
/**
 * Solana RPC nodes at the fetch boundary. `answer` decides per node URL and method; every request
 * is recorded with the node it went to.
 */
function nodes(answer: (url: string, method: string, params: unknown[]) => Reply) {
  const calls: { url: string; method: string; params: unknown[] }[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init!.body))
    calls.push({ url, method, params })
    const r = answer(url, method, params)
    if (r.networkError) throw new TypeError('fetch failed')
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(r.error ? { error: r.error } : { result: r.result }) }), { status: r.status ?? 200 })
  }) as typeof fetch
  return { fetchFn, calls }
}
const tokenAccount = (mint: string, amount: string) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount } } } } } })
const blockhash = { value: { blockhash: base58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1000 } }

// ---- endpoints ----

test('an adapter for a chain with no RPC endpoint is refused with the command that sets one', () => {
  assert.throws(() => solanaAdapter({ ...devnet, rpcUrls: [] }, { fetch: nodes(() => ({})).fetchFn }), /^Error: No RPC endpoint known for Solana Devnet; set one with "chainer config rpc sold <url>"$/)
})

test('a node that cannot be reached is skipped for the next one', async () => {
  const { fetchFn } = nodes((url) => (url.includes('first') ? { networkError: true } : { result: { value: 42 } }))
  assert.deepEqual(await solanaAdapter(twoNodes, { fetch: fetchFn }).getBalances(OWNER, [sol]), [42n])
})

test('a node answering with a server error is skipped for the next one', async () => {
  const { fetchFn } = nodes((url) => (url.includes('first') ? { status: 503, result: undefined } : { result: { value: 42 } }))
  assert.deepEqual(await solanaAdapter(twoNodes, { fetch: fetchFn }).getBalances(OWNER, [sol]), [42n])
})

test('an error from the chain itself is final and not asked again elsewhere', async () => {
  const { fetchFn, calls } = nodes(() => ({ error: { message: 'Transaction simulation failed: insufficient funds' } }))
  await assert.rejects(solanaAdapter(twoNodes, { fetch: fetchFn }).getBalances(OWNER, [sol]), /^Error: Transaction simulation failed: insufficient funds$/)
  assert.deepEqual(calls.map((c) => c.url), ['https://first.node'])
})

test('when every node fails, the last node’s failure is reported', async () => {
  const { fetchFn } = nodes(() => ({ status: 502, result: undefined }))
  await assert.rejects(solanaAdapter(twoNodes, { fetch: fetchFn }).getBalances(OWNER, [sol]), /^Error: second\.node responded 502$/)
})

test('a 200 answer without a result counts as a failed node', async () => {
  const { fetchFn } = nodes((url) => (url.includes('first') ? {} : { result: { value: 1 } }))
  assert.deepEqual(await solanaAdapter(twoNodes, { fetch: fetchFn }).getBalances(OWNER, [sol]), [1n])
})

test('an RPC override replaces the chain’s own nodes', async () => {
  const { fetchFn, calls } = nodes(() => ({ result: { value: 0 } }))
  await solanaAdapter(twoNodes, { fetch: fetchFn, rpcUrl: 'https://mine.node' }).getBalances(OWNER, [sol])
  assert.deepEqual(calls.map((c) => c.url), ['https://mine.node'])
})

// ---- addresses ----

test('a Solana address is valid', () => {
  assert.equal(solanaAdapter(devnet, { fetch: nodes(() => ({})).fetchFn }).validateAddress(OWNER), true)
})

test('an EVM address is not a Solana address', () => {
  assert.equal(solanaAdapter(devnet, { fetch: nodes(() => ({})).fetchFn }).validateAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'), false)
})

test('a base58 string of the wrong length is not a Solana address', () => {
  assert.equal(solanaAdapter(devnet, { fetch: nodes(() => ({})).fetchFn }).validateAddress(OWNER.slice(0, 20)), false)
})

// ---- balances ----

const tokenNode = (classic: ReturnType<typeof tokenAccount>[], extended: ReturnType<typeof tokenAccount>[], lamports = 0) =>
  nodes((_url, method, params) => {
    if (method === 'getBalance') return { result: { value: lamports } }
    const program = (params[1] as { programId: string }).programId
    return { result: { value: program === TOKEN_2022 ? extended : classic } }
  })

test('only SOL asked for: no token accounts are read', async () => {
  const { fetchFn, calls } = tokenNode([], [], 5)
  await solanaAdapter(devnet, { fetch: fetchFn }).getBalances(OWNER, [sol])
  assert.deepEqual(calls.map((c) => c.method), ['getBalance'])
})

test('only tokens asked for: the SOL balance is not read', async () => {
  const { fetchFn, calls } = tokenNode([tokenAccount(USDC_MINT, '1')], [])
  await solanaAdapter(devnet, { fetch: fetchFn }).getBalances(OWNER, [usdc])
  assert.equal(calls.some((c) => c.method === 'getBalance'), false)
})

test('a token held in several accounts is summed', async () => {
  const { fetchFn } = tokenNode([tokenAccount(USDC_MINT, '1500000'), tokenAccount(USDC_MINT, '250000')], [])
  assert.deepEqual(await solanaAdapter(devnet, { fetch: fetchFn }).getBalances(OWNER, [usdc]), [1_750_000n])
})

test('a token under the Token-2022 program is found too', async () => {
  const { fetchFn } = tokenNode([], [tokenAccount(PYUSD_MINT, '9000000')])
  assert.deepEqual(await solanaAdapter(devnet, { fetch: fetchFn }).getBalances(OWNER, [pyusd]), [9_000_000n])
})

test('balances come back in the order asked, SOL in the middle', async () => {
  const { fetchFn } = tokenNode([tokenAccount(USDC_MINT, '7')], [tokenAccount(PYUSD_MINT, '8')], 6)
  assert.deepEqual(await solanaAdapter(devnet, { fetch: fetchFn }).getBalances(OWNER, [usdc, sol, pyusd]), [7n, 6n, 8n])
})

test('a token the wallet has no account for reads as zero', async () => {
  const { fetchFn } = tokenNode([tokenAccount(USDC_MINT, '7')], [])
  assert.deepEqual(await solanaAdapter(devnet, { fetch: fetchFn }).getBalances(OWNER, [pyusd]), [0n])
})

test('a token amount beyond 2^64 is kept exact', async () => {
  // 2^70 base units, more than a JavaScript number holds exactly.
  const { fetchFn } = tokenNode([tokenAccount(USDC_MINT, '1180591620717411303424')], [])
  assert.deepEqual(await solanaAdapter(devnet, { fetch: fetchFn }).getBalances(OWNER, [usdc]), [1180591620717411303424n])
})

// ---- sending ----

const sendNode = (mintOwner: string | null, decimals = 6) => {
  const sent: string[] = []
  const node = nodes((_url, method, params) => {
    if (method === 'getAccountInfo') return { result: { value: mintOwner === null ? null : { owner: mintOwner, data: { parsed: { info: { decimals } } } } } }
    if (method === 'getLatestBlockhash') return { result: blockhash.value ? blockhash : null }
    if (method === 'sendTransaction') return (sent.push(params[0] as string), { result: 'signature' })
    return { result: null }
  })
  const message = (i = 0) => Buffer.from(getTransactionDecoder().decode(getBase64Encoder().encode(sent[i]!)).messageBytes)
  return { ...node, sent, message }
}
const hasKey = (message: Buffer, key: string) => message.includes(Buffer.from(base58.decode(key)))

test('a wallet made from an EVM private key cannot send on Solana', async () => {
  const node = sendNode(TOKEN_CLASSIC)
  await assert.rejects(solanaAdapter(devnet, { fetch: node.fetchFn }).send({ kind: 'solana-transfer', chainKey: 'sold', to: RECIPIENT, amount: 1n }, keyOnlySigner), /^Error: This wallet has no Solana key: it was made from a single EVM private key$/)
})

test('an action for another chain family is refused by name', async () => {
  const node = sendNode(TOKEN_CLASSIC)
  await assert.rejects(solanaAdapter(devnet, { fetch: node.fetchFn }).send({ kind: 'evm-tx', chainKey: 'eth', to: '0x0', data: '0x', value: 0n }, seedSigner), /^Error: Solana cannot run a "evm-tx" action$/)
})

test('a token transfer for a mint that does not exist is refused before anything is signed', async () => {
  const node = sendNode(null)
  await assert.rejects(solanaAdapter(devnet, { fetch: node.fetchFn }).send({ kind: 'solana-transfer', chainKey: 'sold', to: RECIPIENT, amount: 1n, mint: USDC_MINT }, seedSigner), new RegExp(`^Error: Token ${USDC_MINT} does not exist on Solana Devnet$`))
  assert.equal(node.sent.length, 0)
})

test('a token transfer goes through the mint’s own token program', async () => {
  const node = sendNode(TOKEN_2022)
  await solanaAdapter(devnet, { fetch: node.fetchFn }).send({ kind: 'solana-transfer', chainKey: 'sold', to: RECIPIENT, amount: 5n, mint: PYUSD_MINT }, seedSigner)
  assert.deepEqual([hasKey(node.message(), TOKEN_2022), hasKey(node.message(), TOKEN_CLASSIC)], [true, false])
})

test('a token transfer names the mint and the recipient', async () => {
  const node = sendNode(TOKEN_CLASSIC)
  await solanaAdapter(devnet, { fetch: node.fetchFn }).send({ kind: 'solana-transfer', chainKey: 'sold', to: RECIPIENT, amount: 5n, mint: USDC_MINT }, seedSigner)
  assert.deepEqual([hasKey(node.message(), USDC_MINT), hasKey(node.message(), RECIPIENT)], [true, true])
})

test('a SOL transfer without a memo carries no memo program', async () => {
  const node = sendNode(TOKEN_CLASSIC)
  await solanaAdapter(devnet, { fetch: node.fetchFn }).send({ kind: 'solana-transfer', chainKey: 'sold', to: RECIPIENT, amount: 5n }, seedSigner)
  assert.equal(hasKey(node.message(), 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), false)
})

test('send returns the signature the node gives back', async () => {
  const node = sendNode(TOKEN_CLASSIC)
  assert.equal(await solanaAdapter(devnet, { fetch: node.fetchFn }).send({ kind: 'solana-transfer', chainKey: 'sold', to: RECIPIENT, amount: 5n }, seedSigner), 'signature')
})

test('there is nothing to prepare before a Solana transaction', async () => {
  const node = sendNode(TOKEN_CLASSIC)
  await solanaAdapter(devnet, { fetch: node.fetchFn }).prepare({ kind: 'solana-transfer', chainKey: 'sold', to: RECIPIENT, amount: 1n }, seedSigner, () => {})
  assert.deepEqual(node.calls, [])
})

// ---- confirmation ----

/** A node whose signature status goes through the given states, one per poll, then stays on the last. */
const statusNode = (...states: ({ err: unknown; confirmationStatus?: string } | null)[]) => {
  let poll = 0
  return nodes(() => ({ result: { value: [states[Math.min(poll++, states.length - 1)]] } }))
}
const settle = () => new Promise<void>((r) => setImmediate(r))
/** Lets the given number of 2-second polling waits pass on the mocked clock. */
async function passPolls(timers: { tick: (ms: number) => void }, polls: number) {
  for (let i = 0; i < polls; i++) {
    await settle()
    timers.tick(2000)
  }
}

test('a transaction the chain confirmed counts as confirmed', async () => {
  assert.equal(await solanaAdapter(devnet, { fetch: statusNode({ err: null, confirmationStatus: 'confirmed' }).fetchFn }).waitForConfirmation('sig'), true)
})

test('a finalized transaction counts as confirmed', async () => {
  assert.equal(await solanaAdapter(devnet, { fetch: statusNode({ err: null, confirmationStatus: 'finalized' }).fetchFn }).waitForConfirmation('sig'), true)
})

test('a transaction that failed on chain does not count as confirmed', async () => {
  assert.equal(await solanaAdapter(devnet, { fetch: statusNode({ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }).fetchFn }).waitForConfirmation('sig'), false)
})

test('a transaction only processed so far is polled again every 2 seconds until confirmed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const node = statusNode({ err: null, confirmationStatus: 'processed' }, null, { err: null, confirmationStatus: 'confirmed' })
  const result = solanaAdapter(devnet, { fetch: node.fetchFn }).waitForConfirmation('sig')
  await passPolls(t.mock.timers, 2)
  assert.deepEqual([await result, node.calls.length], [true, 3])
})

test('a transaction never seen after 80 polls is reported with advice to check before resending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const node = statusNode(null)
  const result = solanaAdapter(devnet, { fetch: node.fetchFn }).waitForConfirmation('sig')
  await passPolls(t.mock.timers, 80)
  await assert.rejects(result, /^Error: Transaction sig was not seen on Solana Devnet after waiting; it may not have been accepted\. Check an explorer before sending again\.$/)
})
