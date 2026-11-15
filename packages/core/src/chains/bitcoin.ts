import { hex } from '@scure/base'
import * as btc from '@scure/btc-signer'
import { utxoKey } from '../derive.ts'
import type { Chain, ChainAdapter, FetchFn, Signer } from '../types.ts'
import { legacyUtxoAdapter } from './legacy-utxo.ts'
import { UTXO_COINS, type UtxoCoin } from './utxo-coins.ts'

interface Utxo {
  txid: string
  vout: number
  value: number
}

/** Fee cap for a prepared transaction, so a broken fee estimate cannot burn the amount. */
const MAX_FEE_SHARE = 0.05
const MAX_FEE_FLOOR = 5_000n
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function bitcoinAdapter(chain: Chain, opts: { fetch: FetchFn; rpcUrl?: string }): ChainAdapter {
  const coin: UtxoCoin | undefined = UTXO_COINS[chain.key]
  if (!coin) throw new Error(`${chain.name} is not a supported Bitcoin-family chain`)
  if (coin.legacy) return legacyUtxoAdapter(chain, coin, opts)
  const urls = opts.rpcUrl ? [opts.rpcUrl] : chain.rpcUrls.length ? chain.rpcUrls : coin.endpoints
  const network = coin.network
  const parseAddress = btc.Address(network)

  async function api(path: string, init?: RequestInit): Promise<Response> {
    let last: Error = new Error('No endpoint')
    for (const base of urls) {
      try {
        const res = await opts.fetch(`${base.replace(/\/$/, '')}${path}`, init)
        if (res.status === 429 || res.status >= 500) throw new Error(`${new URL(base).host} responded ${res.status}`)
        return res
      } catch (err) {
        last = err as Error
      }
    }
    throw last
  }
  const getJson = async <T>(path: string): Promise<T> => {
    const res = await api(path)
    if (!res.ok) throw new Error(`${chain.name} node responded ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as T
  }
  const broadcast = async (txHex: string): Promise<string> => {
    const res = await api('/tx', { method: 'POST', body: txHex })
    const body = (await res.text()).trim()
    if (!res.ok) throw new Error(`The ${chain.name} node refused the transaction: ${body.slice(0, 300)}`)
    return body
  }

  const keys = (signer: Signer) => {
    if (!signer.seed) throw new Error(`This wallet has no ${chain.name} key: it was made from a single EVM private key`)
    return utxoKey(signer.seed, chain.key)
  }

  /** Fee rate in sats per vbyte for confirmation within about three blocks. */
  async function feeRate(): Promise<number> {
    const estimates = await getJson<Record<string, number>>('/fee-estimates')
    return Math.max(1, Math.ceil(estimates['3'] ?? estimates['6'] ?? 2))
  }

  const ourScript = (address: string) => btc.OutScript.encode(parseAddress.decode(address))

  return {
    chain,
    validateAddress(address) {
      try {
        parseAddress.decode(address)
        return true
      } catch {
        return false
      }
    },

    async getBalances(address, tokens) {
      const s = await getJson<{ chain_stats: { funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { funded_txo_sum: number; spent_txo_sum: number } }>(`/address/${address}`)
      const balance = BigInt(s.chain_stats.funded_txo_sum - s.chain_stats.spent_txo_sum + s.mempool_stats.funded_txo_sum - s.mempool_stats.spent_txo_sum)
      return tokens.map(() => balance)
    },

    async prepare() {},

    async send(action, signer) {
      const key = keys(signer)
      const own = ourScript(key.address)

      if (action.kind === 'utxo-psbt') {
        const raw = /^[0-9a-f]+$/i.test(action.psbt) ? hex.decode(action.psbt.toLowerCase()) : Uint8Array.from(Buffer.from(action.psbt, 'base64'))
        const tx = btc.Transaction.fromPSBT(raw, { allowUnknownInputs: true, allowUnknownOutputs: true })
        let toOthers = 0n
        let totalOut = 0n
        for (let i = 0; i < tx.outputsLength; i++) {
          const out = tx.getOutput(i)
          totalOut += out.amount ?? 0n
          if (!out.script) throw new Error('The transaction has an output without a script; refusing to sign')
          if (hex.encode(out.script) === hex.encode(own)) continue
          if (out.script[0] === 0x6a) {
            if ((out.amount ?? 0n) !== 0n) throw new Error('A data output carries coins; refusing to sign')
            continue
          }
          if (hex.encode(out.script) !== hex.encode(ourScript(action.to))) throw new Error('The transaction pays an address other than the one the route named; refusing to sign')
          toOthers += out.amount ?? 0n
        }
        if (toOthers !== action.amount) throw new Error(`The transaction sends ${toOthers} but the route named ${action.amount}; refusing to sign`)
        let totalIn = 0n
        for (let i = 0; i < tx.inputsLength; i++) {
          const input = tx.getInput(i)
          const out = input.witnessUtxo ?? (input.nonWitnessUtxo ? input.nonWitnessUtxo.outputs[input.index!] : undefined)
          if (!out) throw new Error('An input does not say how much it holds; refusing to sign')
          totalIn += out.amount
        }
        const fee = totalIn - totalOut
        if (fee < 0n || fee > (action.amount * 5n) / 100n + MAX_FEE_FLOOR) throw new Error(`The transaction fee of ${fee} is out of range; refusing to sign`)
        if (tx.sign(key.privateKey) === 0) throw new Error('No input of this transaction belongs to the wallet')
        tx.finalize()
        return broadcast(tx.hex)
      }

      if (action.kind !== 'utxo-send') throw new Error(`${chain.name} cannot run a "${action.kind}" action`)
      const memo = action.memo ? new TextEncoder().encode(action.memo) : undefined
      if (memo && memo.length > 80) throw new Error('A memo longer than 80 bytes does not fit in a standard transaction')

      const utxos = await getJson<Utxo[]>(`/address/${key.address}/utxo`)
      const rate = await feeRate()
      const sorted = [...utxos].sort((a, b) => b.value - a.value)
      const outputsSize = 31 + 31 + (memo ? memo.length + 11 : 0)
      const feeFor = (inputs: number) => BigInt(Math.ceil((11 + 68 * inputs + outputsSize) * rate))

      const chosen: Utxo[] = []
      let have = 0n
      for (const u of sorted) {
        chosen.push(u)
        have += BigInt(u.value)
        if (have >= action.amount + feeFor(chosen.length)) break
      }
      const fee = feeFor(chosen.length)
      if (have < action.amount + fee) throw new Error(`Not enough ${chain.nativeSymbol}: need ${action.amount + fee} sats including the fee, the wallet holds ${have}`)
      if (fee > (action.amount * BigInt(Math.round(MAX_FEE_SHARE * 100))) / 100n + MAX_FEE_FLOOR) throw new Error(`The network fee of ${fee} sats is too high for this amount right now`)

      const tx = new btc.Transaction({ allowUnknownOutputs: true })
      for (const u of chosen) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: own, amount: BigInt(u.value) } })
      tx.addOutputAddress(action.to, action.amount, network)
      if (memo) tx.addOutput({ script: btc.Script.encode(['RETURN', memo]), amount: 0n })
      const change = have - action.amount - fee
      if (change >= BigInt(coin.dust)) tx.addOutputAddress(key.address, change, network)
      tx.sign(key.privateKey)
      tx.finalize()
      return broadcast(tx.hex)
    },

    async waitForConfirmation(txId) {
      // Blocks take ten minutes on average; a few hours is still normal when fees spike.
      for (let i = 0; i < 6 * 60 * 2; i++) {
        const res = await api(`/tx/${txId}/status`)
        if (res.ok && ((await res.json()) as { confirmed: boolean }).confirmed) return true
        await sleep(30_000)
      }
      throw new Error(`Transaction ${txId} is still unconfirmed after 6 hours. Check an explorer; it may have been dropped.`)
    },
  }
}
