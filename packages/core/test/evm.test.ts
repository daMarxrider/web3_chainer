import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, multicall3Abi, parseTransaction, recoverTransactionAddress, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { evmAdapter, type Chain, type EvmTxAction, type Signer, type Token } from '../src/index.ts'

// ---- fixtures ----

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const signer: Signer = { evm: mnemonicToAccount(MNEMONIC) }
/** The first account of the "abandon … about" test mnemonic (BIP-44, m/44'/60'/0'/0/0), a well-known test vector. */
const WALLET = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11'
const chain = { key: 'tst', id: 31337, name: 'Test Chain', family: 'evm', nativeSymbol: 'ETH', rpcUrls: ['https://rpc.example/one'], multicall: MULTICALL, testnet: true } as Chain
const native: Token = { chainKey: 'tst', address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 }
const tokenA: Token = { chainKey: 'tst', address: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa', symbol: 'AAA', decimals: 6 }
const tokenB: Token = { chainKey: 'tst', address: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB', symbol: 'BBB', decimals: 18 }
const SPENDER = '0x5555555555555555555555555555555555555555'
const RECIPIENT = '0x7777777777777777777777777777777777777777'

/**
 * A JSON-RPC node at the fetch boundary. It answers what viem asks for, keeps every raw
 * transaction it is sent, and lets each test set balances, the allowance and receipt outcomes.
 */
const METHOD_NOT_FOUND = Symbol('method not found')

function fakeNode(opts: { nativeBalance?: bigint; tokenBalances?: Record<string, bigint | 'revert'>; allowance?: bigint; receiptStatus?: (n: number) => 'success' | 'reverted' } = {}) {
  const raw: Hex[] = []
  const methods: string[] = []
  const urls: string[] = []
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'eth_chainId':
        return '0x7a69' // 31337
      case 'eth_blockNumber':
        return '0x10'
      case 'eth_getBalance':
        return `0x${(opts.nativeBalance ?? 0n).toString(16)}`
      case 'eth_getTransactionCount':
        return '0x0'
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00' // 1 gwei
      case 'eth_estimateGas':
        return '0x5208' // 21000
      case 'eth_getBlockByNumber':
        return { number: '0x10', baseFeePerGas: '0x3b9aca00', timestamp: '0x0', hash: `0x${'11'.repeat(32)}`, transactions: [] }
      case 'eth_sendRawTransaction':
        raw.push(params[0] as Hex)
        return keccak256(params[0] as Hex)
      case 'eth_getTransactionReceipt': {
        const n = raw.findIndex((r) => keccak256(r) === params[0])
        const ok = (opts.receiptStatus ?? (() => 'success'))(n) === 'success'
        return { transactionHash: params[0], status: ok ? '0x1' : '0x0', blockNumber: '0x10', blockHash: `0x${'22'.repeat(32)}`, logs: [], gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', transactionIndex: '0x0', type: '0x2', from: WALLET, to: RECIPIENT, contractAddress: null, logsBloom: `0x${'00'.repeat(256)}` }
      }
      case 'eth_getTransactionByHash':
        return null
      case 'eth_call': {
        const { to, data } = params[0] as { to: string; data: Hex }
        if (to.toLowerCase() === MULTICALL.toLowerCase()) {
          const { args } = decodeFunctionData({ abi: multicall3Abi, data })
          const calls = args[0] as readonly { target: string }[]
          const results = calls.map((c) => {
            const balance = opts.tokenBalances?.[c.target.toLowerCase()]
            if (balance === undefined || balance === 'revert') return { success: false, returnData: '0x' as Hex }
            return { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: balance }) }
          })
          return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results })
        }
        // Anything else read from a token here is the allowance.
        return encodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', result: opts.allowance ?? 0n })
      }
      default:
        return METHOD_NOT_FOUND
    }
  }
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url))
    const body = JSON.parse(String(init!.body))
    const one = (r: { id: number; method: string; params: unknown[] }) => {
      methods.push(r.method)
      const result = answer(r.method, r.params ?? [])
      // Like a real node, a method it does not have is a JSON-RPC error, not a broken connection.
      return result === METHOD_NOT_FOUND ? { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `the method ${r.method} does not exist/is not available` } } : { jsonrpc: '2.0', id: r.id, result }
    }
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)))
  }) as typeof fetch
  /** The transactions the wallet broadcast, decoded, with the address that signed each. */
  const sent = () => Promise.all(raw.map(async (r) => ({ tx: parseTransaction(r), from: await recoverTransactionAddress({ serializedTransaction: r as never }) })))
  /** Transaction hashes as Ethereum defines them: keccak256 of the signed raw transaction. */
  const hashes = () => raw.map((r) => keccak256(r))
  return { fetchFn, methods, urls, sent, hashes }
}

const approveAction = (amount: bigint): EvmTxAction => ({ kind: 'evm-tx', chainKey: 'tst', to: RECIPIENT, data: '0x', value: 0n, approval: { token: tokenA.address, spender: SPENDER, amount } })
const decodeApprove = (data: Hex | undefined) => decodeFunctionData({ abi: erc20Abi, data: data! }).args as readonly [string, bigint]

// ---- construction ----

test('an adapter for a chain with no RPC endpoint is refused with the command that sets one', () => {
  assert.throws(() => evmAdapter({ ...chain, rpcUrls: [] }, { fetch: fakeNode().fetchFn }), /No RPC endpoint known for Test Chain; set one with "chainer config rpc tst <url>"/)
})

test('an RPC override replaces the chain’s own endpoints', async () => {
  const node = fakeNode()
  await evmAdapter(chain, { fetch: node.fetchFn, rpcUrl: 'https://my.node/rpc' }).getBalances(WALLET, [native])
  assert.deepEqual([...new Set(node.urls)], ['https://my.node/rpc'])
})

// ---- addresses ----

test('a correctly checksummed address is valid', () => {
  assert.equal(evmAdapter(chain, { fetch: fakeNode().fetchFn }).validateAddress(WALLET), true)
})

test('an all-lowercase address is valid, since it carries no checksum', () => {
  assert.equal(evmAdapter(chain, { fetch: fakeNode().fetchFn }).validateAddress(WALLET.toLowerCase()), true)
})

test('a mixed-case address with a wrong checksum is invalid', () => {
  // The last letter's case flipped: "…Eda94" -> "…EdA94".
  assert.equal(evmAdapter(chain, { fetch: fakeNode().fetchFn }).validateAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEdA94'), false)
})

test('an address one hex digit short is invalid', () => {
  assert.equal(evmAdapter(chain, { fetch: fakeNode().fetchFn }).validateAddress(WALLET.slice(0, -1)), false)
})

test('an address without the 0x prefix is invalid', () => {
  assert.equal(evmAdapter(chain, { fetch: fakeNode().fetchFn }).validateAddress(WALLET.slice(2)), false)
})

test('a Solana address is invalid on an EVM chain', () => {
  assert.equal(evmAdapter(chain, { fetch: fakeNode().fetchFn }).validateAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), false)
})

// ---- balances ----

test('balances come back in the order the tokens were asked for, coin in the middle', async () => {
  const node = fakeNode({ nativeBalance: 5n, tokenBalances: { [tokenA.address.toLowerCase()]: 100n, [tokenB.address.toLowerCase()]: 200n } })
  const balances = await evmAdapter(chain, { fetch: node.fetchFn }).getBalances(WALLET, [tokenA, native, tokenB])
  assert.deepEqual(balances, [100n, 5n, 200n])
})

test('a token whose balance call fails reads as zero without hiding the others', async () => {
  const node = fakeNode({ tokenBalances: { [tokenA.address.toLowerCase()]: 'revert', [tokenB.address.toLowerCase()]: 200n } })
  const balances = await evmAdapter(chain, { fetch: node.fetchFn }).getBalances(WALLET, [tokenA, tokenB])
  assert.deepEqual(balances, [0n, 200n])
})

test('only the coin asked for: no contract call is made', async () => {
  const node = fakeNode({ nativeBalance: 7n })
  await evmAdapter(chain, { fetch: node.fetchFn }).getBalances(WALLET, [native])
  assert.equal(node.methods.includes('eth_call'), false)
})

test('only tokens asked for: the coin balance is not read', async () => {
  const node = fakeNode({ tokenBalances: { [tokenA.address.toLowerCase()]: 1n } })
  await evmAdapter(chain, { fetch: node.fetchFn }).getBalances(WALLET, [tokenA])
  assert.equal(node.methods.includes('eth_getBalance'), false)
})

test('no tokens asked for gives no balances', async () => {
  assert.deepEqual(await evmAdapter(chain, { fetch: fakeNode().fetchFn }).getBalances(WALLET, []), [])
})

test('a balance larger than 2^64 comes back exactly', async () => {
  // 2^70 = 1180591620717411303424; would lose precision as a JavaScript number.
  const node = fakeNode({ tokenBalances: { [tokenB.address.toLowerCase()]: 1180591620717411303424n } })
  assert.deepEqual(await evmAdapter(chain, { fetch: node.fetchFn }).getBalances(WALLET, [tokenB]), [1180591620717411303424n])
})

test('token balances on a chain without a multicall contract fail loudly instead of reading as zero', async () => {
  const noMulticall = { ...chain, multicall: undefined }
  await assert.rejects(evmAdapter(noMulticall, { fetch: fakeNode().fetchFn }).getBalances(WALLET, [tokenA]))
})

// ---- approvals ----

test('an action without an approval sends nothing before the main transaction', async () => {
  const node = fakeNode()
  await evmAdapter(chain, { fetch: node.fetchFn }).prepare({ kind: 'evm-tx', chainKey: 'tst', to: RECIPIENT, data: '0x', value: 0n }, signer, () => {})
  assert.deepEqual(await node.sent(), [])
})

test('an allowance that already covers the amount sends no approval', async () => {
  const node = fakeNode({ allowance: 1000n })
  await evmAdapter(chain, { fetch: node.fetchFn }).prepare(approveAction(1000n), signer, () => {})
  assert.deepEqual(await node.sent(), [])
})

test('a zero allowance is raised with one approval of exactly the amount, for the spender, on the token', async () => {
  const node = fakeNode({ allowance: 0n })
  await evmAdapter(chain, { fetch: node.fetchFn }).prepare(approveAction(1000n), signer, () => {})
  const [only] = await node.sent()
  assert.deepEqual([only!.from, only!.tx.to, ...decodeApprove(only!.tx.data)], [WALLET, tokenA.address.toLowerCase(), SPENDER, 1000n])
})

test('a too-small non-zero allowance is reset to zero first, then set (tokens like USDT refuse a direct change)', async () => {
  const node = fakeNode({ allowance: 10n })
  await evmAdapter(chain, { fetch: node.fetchFn }).prepare(approveAction(1000n), signer, () => {})
  const amounts = (await node.sent()).map((s) => decodeApprove(s.tx.data)[1])
  assert.deepEqual(amounts, [0n, 1000n])
})

test('the reset and the approval are announced in order', async () => {
  const events: string[] = []
  await evmAdapter(chain, { fetch: fakeNode({ allowance: 10n }).fetchFn }).prepare(approveAction(1000n), signer, (m) => events.push(m))
  assert.deepEqual(events, ['Resetting existing token allowance', 'Approving the bridge contract to spend the token'])
})

test('a reverted approval stops the transfer with the transaction hash', async () => {
  const node = fakeNode({ allowance: 0n, receiptStatus: () => 'reverted' })
  await assert.rejects(evmAdapter(chain, { fetch: node.fetchFn }).prepare(approveAction(1000n), signer, () => {}), /^Error: Token approval reverted \(0x[0-9a-f]{64}\)$/)
})

test('a reverted reset stops before the real approval is sent', async () => {
  const node = fakeNode({ allowance: 10n, receiptStatus: () => 'reverted' })
  await assert.rejects(evmAdapter(chain, { fetch: node.fetchFn }).prepare(approveAction(1000n), signer, () => {}), /Token approval reverted/)
  assert.equal((await node.sent()).length, 1)
})

// ---- sending ----

test('a non-EVM action is refused by name', async () => {
  await assert.rejects(evmAdapter(chain, { fetch: fakeNode().fetchFn }).send({ kind: 'solana-transfer', chainKey: 'sol', to: 'x', amount: 1n }, signer), /An EVM chain cannot run a "solana-transfer" action/)
})

test('the main transaction is signed by the wallet and carries exactly the action’s recipient, data and value on this chain', async () => {
  const node = fakeNode()
  await evmAdapter(chain, { fetch: node.fetchFn }).send({ kind: 'evm-tx', chainKey: 'tst', to: RECIPIENT, data: '0xdeadbeef', value: 123456789n }, signer)
  const [only] = await node.sent()
  assert.deepEqual([only!.from, only!.tx.to, only!.tx.data, only!.tx.value, only!.tx.chainId], [WALLET, RECIPIENT, '0xdeadbeef', 123456789n, 31337])
})

test('a gas limit given by the route is used instead of an estimate', async () => {
  const node = fakeNode()
  await evmAdapter(chain, { fetch: node.fetchFn }).send({ kind: 'evm-tx', chainKey: 'tst', to: RECIPIENT, data: '0x', value: 0n, gasLimit: 300000n }, signer)
  const [only] = await node.sent()
  assert.equal(only!.tx.gas, 300000n)
})

test('send returns the hash of the broadcast transaction', async () => {
  const node = fakeNode()
  const hash = await evmAdapter(chain, { fetch: node.fetchFn }).send({ kind: 'evm-tx', chainKey: 'tst', to: RECIPIENT, data: '0x', value: 1n }, signer)
  assert.deepEqual([hash], node.hashes())
})

// ---- confirmation ----

test('a mined transaction with status success counts as confirmed', async () => {
  const node = fakeNode()
  const adapter = evmAdapter(chain, { fetch: node.fetchFn })
  const hash = await adapter.send({ kind: 'evm-tx', chainKey: 'tst', to: RECIPIENT, data: '0x', value: 1n }, signer)
  assert.equal(await adapter.waitForConfirmation(hash), true)
})

test('a mined transaction that reverted does not count as confirmed', async () => {
  const node = fakeNode({ receiptStatus: () => 'reverted' })
  const adapter = evmAdapter(chain, { fetch: node.fetchFn })
  const hash = await adapter.send({ kind: 'evm-tx', chainKey: 'tst', to: RECIPIENT, data: '0x', value: 1n }, signer)
  assert.equal(await adapter.waitForConfirmation(hash), false)
})
