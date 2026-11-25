import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { solanaSecretKey } from '../derive.ts'
import { FileStorageManager, FileUnifiedStorage } from './atomiq-storage.ts'
import { loadSdk } from '../optional.ts'
import type { BridgeProvider, Chain, FetchFn, Quote, QuoteRequest, RunContext, Signer, TransferStatus } from '../types.ts'

/**
 * Atomiq (trustless Bitcoin <-> Solana swaps with liquidity providers), through its TypeScript
 * SDK, which verifies swaps locally. The SDK and its connectors are optional packages: without
 * them this provider is simply not created. Terms: "Third-party terms" in docs/PLAN.md (Atomiq).
 *
 * Bitcoin -> SOL uses Atomiq's legacy protocol: a transaction on Solana opens a swap address
 * (it takes a refundable deposit and a watchtower fee in SOL), the wallet pays that address in
 * BTC, and the swap is claimed on Solana, by a watchtower or by this wallet. SOL -> Bitcoin
 * commits on Solana, the LP pays out in BTC, and the wallet refunds itself if that fails.
 */

const SOLANA_NATIVE = '11111111111111111111111111111111'

/** The chain pairs Atomiq can swap that this app has adapters for. */
const NETWORKS = {
  mainnet: { btc: 'btc', sol: 'sol' },
  testnet: { btc: 'btct', sol: 'sold' },
} as const

/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK is optional, so its types are not available here */
type Sdk = any

export interface AtomiqOptions {
  /** Where the SDK keeps its swap database; one folder per network. */
  dir: string
  /** Solana RPC the SDK should use. */
  solanaRpc?: string
  /** Replaces how the optional packages are loaded (tests). */
  load?: (pkg: string) => Promise<unknown>
}

interface Modules {
  sdk: Sdk
  solana: Sdk
  web3: Sdk
}

async function loadModules(load: (pkg: string) => Promise<unknown>): Promise<Modules | undefined> {
  const [sdk, solana, web3] = await Promise.all(['@atomiqlabs/sdk', '@atomiqlabs/chain-solana', '@solana/web3.js'].map((p) => loadSdk(p, load)))
  return sdk && solana && web3 ? { sdk, solana, web3 } : undefined
}

/** Creates the provider, or undefined when the optional packages are not installed. */
export async function atomiqProvider(fetchFn: FetchFn, chains: Chain[], opts: AtomiqOptions & { testnet: boolean }): Promise<BridgeProvider | undefined> {
  const loaded = await loadModules(opts.load ?? ((pkg) => import(pkg)))
  if (!loaded) return undefined
  const mods: Modules = loaded
  const net = opts.testnet ? NETWORKS.testnet : NETWORKS.mainnet
  const chainOf = (key: string) => chains.find((c) => c.key === key)

  let swapperPromise: Promise<{ swapper: Sdk; tokens: Sdk }> | undefined
  const getSwapper = () =>
    (swapperPromise ??= (async () => {
      const { sdk, solana, web3 } = mods
      const folder = join(opts.dir, 'atomiq', opts.testnet ? 'testnet4' : 'mainnet')
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const factory = new sdk.SwapperFactory([solana.SolanaInitializer])
      const rpc = opts.solanaRpc ?? chainOf(net.sol)?.rpcUrls[0] ?? (opts.testnet ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com')
      const swapper = factory.newSwapper({
        chains: { SOLANA: { rpcUrl: new web3.Connection(rpc, 'confirmed') } },
        bitcoinNetwork: opts.testnet ? sdk.BitcoinNetwork.TESTNET4 : sdk.BitcoinNetwork.MAINNET,
        swapStorage: (chainId: string) => new FileUnifiedStorage(join(folder, `swaps-${chainId}.json`)),
        chainStorageCtor: (name: string) => new FileStorageManager(join(folder, `store-${name}.json`)),
      })
      await swapper.init()
      return { swapper, tokens: factory.Tokens }
    })())

  /** Wallet object the SDK signs Solana transactions with, made from the wallet's seed. */
  const solanaWallet = (signer: Signer) => {
    if (!signer.seed) throw new Error('Atomiq needs a wallet made from a seed phrase (Solana key)')
    return new mods.solana.SolanaKeypairWallet(mods.web3.Keypair.fromSeed(solanaSecretKey(signer.seed)))
  }

  /** The direction of a request, or undefined if Atomiq does not swap this pair. */
  const direction = (request: QuoteRequest): 'frombtc' | 'tobtc' | undefined => {
    const { from, to } = request
    const isSol = (t: typeof from, key: string) => t.chainKey === key && t.address === SOLANA_NATIVE
    const isBtc = (t: typeof from, key: string) => t.chainKey === key && t.address.toLowerCase() === 'bitcoin'
    if (isBtc(from, net.btc) && isSol(to, net.sol)) return 'frombtc'
    if (isSol(from, net.sol) && isBtc(to, net.btc)) return 'tobtc'
    return undefined
  }

  const usd = async (amount: { usdValue(): Promise<number> } | undefined) => {
    try {
      return amount ? await amount.usdValue() : 0
    } catch {
      return 0
    }
  }

  /** Runs whatever steps of the swap are left, from its current state. Used for the first run and for resume. */
  async function drive(swap: Sdk, dir: 'frombtc' | 'tobtc', ctx: RunContext): Promise<TransferStatus> {
    const { sdk } = mods
    const wallet = solanaWallet(ctx.signer)
    const state: number = swap.getState()
    // Written before the transaction is sent, so a crash cannot lose track of it.
    let saving: Promise<void> | undefined
    const beforeSend = (txId: string) => void (saving = ctx.checkpoint({ txId, state: { step: 'committing' } }))

    if (dir === 'tobtc') {
      const S = sdk.ToBTCSwapState
      if (state === S.CREATED) {
        ctx.say('Committing the swap on Solana')
        await swap.commit(wallet, undefined, undefined, beforeSend)
        await saving
        await swap.waitTillCommited()
        await ctx.checkpoint({ state: { step: 'committed' } })
      }
      if (swap.isSuccessful()) return { state: 'done', destTxId: swap.getOutputTxId() ?? undefined, receivedAmount: swap.getOutput().rawAmount }
      if (!swap.isRefundable() && !swap.isFailed() && !swap.isFinished()) {
        ctx.say('Waiting for the liquidity provider to send the Bitcoin')
        const paid = await swap.waitForPayment()
        if (paid) return { state: 'done', destTxId: swap.getOutputTxId() ?? undefined, receivedAmount: swap.getOutput().rawAmount }
      }
      if (swap.isRefundable()) {
        ctx.say('The liquidity provider did not pay; refunding on Solana')
        await swap.refund(wallet)
        return { state: 'failed', detail: 'The liquidity provider did not pay out; the SOL was refunded to the wallet' }
      }
      return swap.isSuccessful() ? { state: 'done', destTxId: swap.getOutputTxId() ?? undefined } : { state: 'failed', detail: 'The swap ended without a payout' }
    }

    // Bitcoin -> SOL
    const S = sdk.FromBTCSwapState
    if (state === S.PR_CREATED) {
      ctx.say('Opening the swap address on Solana (takes a refundable deposit and a watchtower fee in SOL)')
      await swap.commit(wallet, undefined, undefined, beforeSend)
      await saving
      await swap.waitTillCommited()
      await ctx.checkpoint({ state: { step: 'opened' } })
    }
    if (swap.getState() === S.CLAIM_COMMITED && !ctx.state?.btcTx) {
      if (Date.now() > swap.getTimeoutTime() - 5 * 60_000) throw new Error('The swap address is about to expire; no Bitcoin was sent. The deposit is released when the swap expires.')
      const btc = ctx.adapterFor(net.btc)
      // Exactly the quoted amount: a different amount to the swap address can lose the funds.
      const amount: bigint = swap.getInput().rawAmount
      ctx.say(`Sending exactly ${amount} sats to the swap address`)
      const btcTx = await btc.send({ kind: 'utxo-send', chainKey: net.btc, to: swap.getAddress(), amount }, ctx.signer)
      await ctx.checkpoint({ state: { step: 'btc-sent', btcTx } })
    }
    if (swap.getState() === S.CLAIM_COMMITED) {
      ctx.say('Waiting for the Bitcoin transaction to confirm')
      await swap.waitForBitcoinTransaction((txId?: string, confirmations?: number, target?: number) => {
        if (txId) ctx.say(`Bitcoin transaction ${txId}: ${confirmations ?? 0}/${target ?? '?'} confirmations`)
      })
    }
    if (swap.getState() === S.BTC_TX_CONFIRMED) {
      ctx.say('Waiting for the watchtowers to settle the swap on Solana')
      const settled = await swap.waitTillClaimed(60)
      if (!settled) {
        ctx.say('Not settled automatically; claiming with this wallet')
        await swap.claim(wallet)
      }
    }
    if (swap.isSuccessful()) return { state: 'done', destTxId: swap.getOutputTxId() ?? undefined, receivedAmount: swap.getOutput().rawAmount }
    if (swap.getState() === S.EXPIRED || swap.getState() === S.FAILED) return { state: 'failed', detail: 'The swap expired or failed before the Bitcoin was confirmed' }
    return { state: 'pending', detail: 'Waiting for the swap to settle' }
  }

  return {
    name: 'atomiq',
    traits: { nonCustodial: true, needsApiKey: false },

    async getQuotes(request): Promise<Quote[]> {
      const dir = direction(request)
      if (!dir) return []
      const { swapper, tokens } = await getSwapper()
      const [src, dst] = dir === 'frombtc' ? [tokens.BITCOIN.BTC, tokens.SOLANA.SOL] : [tokens.SOLANA.SOL, tokens.BITCOIN.BTC]
      // EXACT_IN: the amount is what leaves the wallet.
      const swap = await swapper.swap(src, dst, request.amount, mods.sdk.SwapAmountType.EXACT_IN, dir === 'frombtc' ? undefined : request.fromAddress, request.toAddress)
      const output: bigint = swap.getOutput().rawAmount
      const network = dir === 'tobtc' ? await usd(await swap.getSmartChainNetworkFee()) : await usd(swap.getClaimerBounty())
      return [
        {
          provider: 'atomiq',
          tool: dir === 'frombtc' ? 'atomiq-btc-sol' : 'atomiq-sol-btc',
          request,
          // The liquidity provider quotes a fixed output, so there is no slippage.
          toAmount: output,
          toAmountMin: output,
          // Fees are inside the output; the Solana network fee (or watchtower fee) comes on top.
          costUsd: network,
          etaSeconds: dir === 'frombtc' ? 3600 : 1800,
          viaSymbols: ['BTC', 'SOL'],
          raw: { swap },
          statusRef: { dir, swapId: swap.getId() },
        },
      ]
    },

    async buildActions(): Promise<never> {
      throw new Error('Atomiq runs the whole swap itself')
    },
    async getStatus(): Promise<never> {
      throw new Error('Atomiq swaps are followed by the swap run, not by polling')
    },

    async run(quote, ctx): Promise<TransferStatus> {
      const { swap } = quote.raw as { swap: Sdk }
      const dir = quote.statusRef.dir as 'frombtc' | 'tobtc'
      await ctx.checkpoint({ state: { swapId: swap.getId(), dir, step: 'quoted' } })
      return drive(swap, dir, ctx)
    },

    async resume(ctx): Promise<TransferStatus> {
      const { swapId, dir } = ctx.state as { swapId?: string; dir?: 'frombtc' | 'tobtc' }
      if (!swapId || !dir) throw new Error('The saved Atomiq swap has no id; it cannot be resumed')
      const { swapper } = await getSwapper()
      const swap = await swapper.getSwapById(swapId)
      if (!swap) throw new Error(`Atomiq has no swap ${swapId} in its database (${opts.dir}); check it by hand before doing anything else`)
      return drive(swap, dir, ctx)
    },
  }
}
