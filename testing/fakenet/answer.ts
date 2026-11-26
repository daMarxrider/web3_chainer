/**
 * The fake network's answers: plays LI.FI, the chains' JSON-RPC nodes, THORChain/Maya and the
 * token list from a World. Used by the CLI tests (preload.ts installs it as fetch) and by the GUI
 * browser tests (which route the page's requests to it). A request nothing here answers is refused
 * and logged, so no test can reach the real internet unnoticed.
 */
import { decodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, multicall3Abi, type Hex } from 'viem'
import { DIAMOND, MULTICALL, ZERO, type LogLine, type World, type WorldToken } from './world.ts'

export function fakeNetwork(world: World, log: (line: LogLine) => void): (url: string, init?: { method?: string; body?: string }) => Promise<Response> {
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
  const chainById = (id: number | string) => world.chains.find((c) => c.id === Number(id))
  const chainByKey = (key: string) => world.chains.find((c) => c.key === key)
  const native = (key: string): WorldToken => {
    const c = chainByKey(key)!
    return { chain: key, symbol: c.coin, address: ZERO, decimals: 18, price: c.price }
  }
  const tokensOf = (key: string): WorldToken[] => [native(key), ...world.tokens.filter((t) => t.chain === key)]
  const findToken = (key: string, query: string) => [...tokensOf(key), ...(world.unlisted ?? []).filter((t) => t.chain === key)].find((t) => t.symbol.toLowerCase() === query.toLowerCase() || t.address.toLowerCase() === query.toLowerCase())
  const lifiToken = (t: WorldToken) => ({ address: t.address, chainId: chainByKey(t.chain)!.id, symbol: t.symbol, decimals: t.decimals, priceUSD: t.price === undefined ? undefined : String(t.price), name: t.name ?? t.symbol, verificationStatus: t.status ?? 'verified' })
  const parseSpec = (spec: string) => {
    const [symbol, key] = spec.split('@') as [string, string]
    return findToken(key, symbol)!
  }
  const balanceOf = (owner: string, key: string, token: string): bigint => {
    const byOwner = Object.entries(world.balances ?? {}).find(([a]) => a.toLowerCase() === owner.toLowerCase())?.[1] ?? {}
    const entry = Object.entries(byOwner).find(([k]) => k.toLowerCase() === `${key}:${token}`.toLowerCase())
    return BigInt(entry?.[1] ?? '0')
  }

  // ---- LI.FI ----

  function lifi(url: URL, body: unknown): Response | undefined {
    const p = url.pathname
    if (p === '/v1/chains') {
      return json({ chains: world.chains.map((c) => ({ chainType: 'EVM', key: c.key, id: c.id, name: c.name, mainnet: c.mainnet ?? true, multicallAddress: MULTICALL, nativeToken: lifiToken(native(c.key)), metamask: { rpcUrls: [`https://rpc-${c.key}.fake`] } })) })
    }
    if (p === '/v1/token') {
      const c = chainById(url.searchParams.get('chain')!)
      const t = c && findToken(c.key, url.searchParams.get('token')!)
      return t ? json(lifiToken(t)) : json({ message: `Could not find token '${url.searchParams.get('token')}' on chain '${url.searchParams.get('chain')}'` }, 404)
    }
    if (p === '/v1/tokens') {
      if (world.tokensError) return json({ message: world.tokensError.message }, world.tokensError.status)
      const id = url.searchParams.get('chains')!
      const c = chainById(id)
      return json({ tokens: c ? { [id]: tokensOf(c.key).map(lifiToken) } : {} })
    }
    if (p === '/v1/advanced/routes') {
      if (world.routesError) return json({ message: world.routesError.message }, world.routesError.status)
      const r = body as { fromChainId: number; toChainId: number; fromTokenAddress: string; toTokenAddress: string; fromAmount: string; options: { bridges: { allow?: string[]; deny?: string[] } } }
      const routes = (world.routes ?? [])
        .filter((w) => {
          const [from, to] = [parseSpec(w.from), parseSpec(w.to)]
          return chainByKey(from.chain)!.id === r.fromChainId && chainByKey(to.chain)!.id === r.toChainId && from.address.toLowerCase() === r.fromTokenAddress.toLowerCase() && to.address.toLowerCase() === r.toTokenAddress.toLowerCase()
        })
        .filter((w) => !r.options.bridges.deny?.includes(w.tool) && (!r.options.bridges.allow || r.options.bridges.allow.includes(w.tool)))
        .map((w) => {
          const [from, to] = [parseSpec(w.from), parseSpec(w.to)]
          const toAmount = (BigInt(r.fromAmount) * BigInt(Math.round(w.rate * 1e6)) * 10n ** BigInt(to.decimals)) / (1_000_000n * 10n ** BigInt(from.decimals))
          const step = {
            tool: w.tool,
            action: { fromToken: lifiToken(from), toToken: lifiToken(to), fromChainId: r.fromChainId, toChainId: r.toChainId, fromAmount: r.fromAmount },
            estimate: {
              approvalAddress: DIAMOND,
              toAmount: toAmount.toString(),
              toAmountMin: ((toAmount * 995n) / 1000n).toString(),
              toAmountUSD: to.price === undefined ? undefined : String((Number(toAmount) / 10 ** to.decimals) * to.price),
              executionDuration: w.seconds ?? 60,
              feeCosts: w.feeUsd ? [{ amountUSD: String(w.feeUsd), included: false }] : [],
              gasCosts: [{ amountUSD: String(w.gasUsd ?? 0.1) }],
            },
          }
          return { steps: [step] }
        })
      return json({ routes })
    }
    if (p === '/v1/advanced/stepTransaction') {
      const step = body as { action: { fromToken: { address: string }; fromAmount: string } }
      const value = step.action.fromToken.address === ZERO ? `0x${BigInt(step.action.fromAmount).toString(16)}` : '0x0'
      return json({ ...step, transactionRequest: { to: DIAMOND, data: '0xdeadbeef', value, gasLimit: '0x493e0' } })
    }
    if (p === '/v1/status') {
      return json({ status: world.status ?? 'DONE', substatus: world.status === 'FAILED' ? 'NOT_PROCESSABLE_REFUND_NEEDED' : 'COMPLETED', receiving: { ...(world.received ? { amount: world.received } : {}), txHash: '0xdestination' } })
    }
    return undefined
  }

  // ---- JSON-RPC nodes ----

  const NOT_FOUND = Symbol('method not found')
  function rpc(key: string, method: string, params: unknown[]): unknown {
    const chain = chainByKey(key)!
    switch (method) {
      case 'eth_chainId':
        return `0x${chain.id.toString(16)}`
      case 'eth_blockNumber':
        return '0x10'
      case 'eth_getBalance':
        return `0x${balanceOf(params[0] as string, key, ZERO).toString(16)}`
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
        return `0x${BigInt(world.gasPriceWei ?? '1000000000').toString(16)}`
      case 'eth_getBlockByNumber':
        return { number: '0x10', baseFeePerGas: `0x${BigInt(world.gasPriceWei ?? '1000000000').toString(16)}`, timestamp: '0x0', hash: `0x${'11'.repeat(32)}`, transactions: [] }
      case 'eth_estimateGas':
        return '0x5208'
      case 'eth_getTransactionCount':
        return '0x0'
      case 'eth_sendRawTransaction':
        log({ kind: 'broadcast', chain: key, raw: params[0] as string })
        return keccak256(params[0] as Hex)
      case 'eth_getTransactionReceipt':
        return { transactionHash: params[0], status: world.receipt === 'reverted' ? '0x0' : '0x1', blockNumber: '0x10', blockHash: `0x${'22'.repeat(32)}`, logs: [], gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', transactionIndex: '0x0', type: '0x2', from: ZERO, to: ZERO, contractAddress: null, logsBloom: `0x${'00'.repeat(256)}` }
      case 'eth_call': {
        const { to, data } = params[0] as { to: string; data: Hex }
        if (to.toLowerCase() === MULTICALL.toLowerCase()) {
          const calls = decodeFunctionData({ abi: multicall3Abi, data }).args[0] as readonly { target: string; callData: Hex }[]
          const results = calls.map((c) => {
            const owner = decodeFunctionData({ abi: erc20Abi, data: c.callData }).args[0] as string
            return { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: balanceOf(owner, key, c.target) }) }
          })
          return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results })
        }
        return encodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', result: BigInt(world.allowance ?? '0') })
      }
      default:
        return NOT_FOUND
    }
  }

  return async (href, init) => {
    const url = new URL(href)
    const body = init?.body ? JSON.parse(init.body) : undefined
    const rpcHost = /^rpc-(.+)\.fake$/.exec(url.host)
    if (rpcHost) {
      const one = (r: { id: number; method: string; params?: unknown[] }) => {
        log({ kind: 'request', url: url.href, method: r.method })
        const result = rpc(rpcHost[1]!, r.method, r.params ?? [])
        return result === NOT_FOUND ? { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `the method ${r.method} does not exist/is not available` } } : { jsonrpc: '2.0', id: r.id, result }
      }
      return json(Array.isArray(body) ? body.map(one) : one(body))
    }
    log({ kind: 'request', url: url.href })
    if (url.host === 'li.quest') {
      const answer = lifi(url, body)
      if (answer) return answer
    }
    if (url.pathname.endsWith('/pools')) return json([]) // THORChain and Maya: no pools, so no quotes
    if (url.host === 'tokens.uniswap.org') return world.tokenList ? json(world.tokenList) : json({ message: 'not found' }, 404)
    log({ kind: 'unexpected', url: url.href })
    throw new TypeError(`fake network: nothing answers ${url.href}`)
  }
}
