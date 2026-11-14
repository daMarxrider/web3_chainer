import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  fallback,
  http,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import type { Chain, ChainAdapter, FetchFn } from '../types.ts'

export function evmAdapter(chain: Chain, opts: { fetch: FetchFn; rpcUrl?: string }): ChainAdapter {
  const urls = opts.rpcUrl ? [opts.rpcUrl] : chain.rpcUrls
  if (urls.length === 0) throw new Error(`No RPC endpoint known for ${chain.name}; set one with "chainer config rpc ${chain.key} <url>"`)

  const viemChain = defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: urls } },
    contracts: chain.multicall ? { multicall3: { address: chain.multicall as Address } } : undefined,
  })
  const transport = fallback(urls.map((url) => http(url, { fetchFn: opts.fetch })))
  const client = createPublicClient({ chain: viemChain, transport })

  return {
    chain,
    validateAddress: (address) => isAddress(address),

    async getBalances(address, tokens) {
      const owner = address as Address
      const erc20 = tokens.filter((t) => t.address.toLowerCase() !== zeroAddress)
      const [native, results] = await Promise.all([
        tokens.length > erc20.length ? client.getBalance({ address: owner }) : 0n,
        erc20.length === 0
          ? []
          : client.multicall({
              allowFailure: true,
              contracts: erc20.map((t) => ({ address: t.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as const),
            }),
      ])
      let i = 0
      return tokens.map((t) => {
        if (t.address.toLowerCase() === zeroAddress) return native
        const r = results[i++]!
        return r.status === 'success' ? (r.result as bigint) : 0n
      })
    },

    async prepare(action, signer, onEvent) {
      if (!action.approval) return
      const wallet = createWalletClient({ account: signer.evm, chain: viemChain, transport })
      const token = action.approval.token as Address
      const spender = action.approval.spender as Address
      const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [signer.evm.address, spender] })
      if (allowance >= action.approval.amount) return

      const approve = async (amount: bigint) => {
        const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
        const receipt = await client.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error(`Token approval reverted (${hash})`)
      }
      // Some tokens (USDT on Ethereum) refuse to change a non-zero allowance directly.
      if (allowance > 0n) {
        onEvent('Resetting existing token allowance')
        await approve(0n)
      }
      onEvent('Approving the bridge contract to spend the token')
      await approve(action.approval.amount)
    },

    async send(action, signer) {
      const wallet = createWalletClient({ account: signer.evm, chain: viemChain, transport })
      return wallet.sendTransaction({ to: action.to as Address, data: action.data as Hex, value: action.value, gas: action.gasLimit })
    },

    async waitForConfirmation(txId) {
      const receipt = await client.waitForTransactionReceipt({ hash: txId as Hex })
      return receipt.status === 'success'
    },
  }
}
