import { utxoKey } from '../derive.ts'
import type { Chain, ChainAdapter, FetchFn, Signer } from '../types.ts'
import { addressCodec, bytesToHex, dataScript, outputScript, signLegacyTx, type LegacyInput, type LegacyOutput } from './legacy-tx.ts'
import type { UtxoCoin } from './utxo-coins.ts'

interface Coin {
  txid: string
  vout: number
  value: bigint
}

/** One data source: what the adapter needs from it, in the coin's own units. */
interface Backend {
  balance(address: string): Promise<bigint>
  /** Confirmed coins only, so a coin that a pending transaction already spends is not picked twice. */
  coins(address: string): Promise<Coin[]>
  /** Suggested fee in smallest units per byte, when the source gives one. */
  feeRate?(): Promise<number | undefined>
  broadcast(hex: string): Promise<string>
  confirmed(txid: string): Promise<boolean>
}

type Call = (path: string, init?: RequestInit) => Promise<Response>

async function json<T>(call: Call, path: string, init?: RequestInit): Promise<T> {
  const res = await call(path, init)
  if (!res.ok) throw new Error(`The node responded ${res.status} for ${path.split('?')[0]}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as T
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const sat = (n: number | string) => BigInt(Math.round(Number(n)))

// BlockCypher (Dogecoin, Dash). Amounts in the smallest unit, fees per kB.
const blockcypher = (call: Call): Backend => ({
  async balance(a) {
    return sat((await json<{ final_balance: number }>(call, `/addrs/${a}/balance`)).final_balance)
  },
  async coins(a) {
    const r = await json<{ txrefs?: { tx_hash: string; tx_output_n: number; value: number; double_spend: boolean }[] }>(call, `/addrs/${a}?unspentOnly=true&limit=200`)
    return (r.txrefs ?? []).filter((t) => !t.double_spend).map((t) => ({ txid: t.tx_hash, vout: t.tx_output_n, value: sat(t.value) }))
  },
  async feeRate() {
    const r = await json<{ medium_fee_per_kb?: number }>(call, '')
    return r.medium_fee_per_kb ? r.medium_fee_per_kb / 1000 : undefined
  },
  async broadcast(hex) {
    const res = await call('/txs/push', post({ tx: hex }))
    const body = await res.text()
    if (!res.ok) throw new Error(`The node refused the transaction: ${body.slice(0, 300)}`)
    return (JSON.parse(body) as { tx: { hash: string } }).tx.hash
  },
  async confirmed(txid) {
    const res = await call(`/txs/${txid}?limit=1`)
    return res.ok && ((await res.json()) as { confirmations?: number }).confirmations! > 0
  },
})

// bitcoin.com-style REST v2 in front of a Bitcoin Cash node.
const bchRest = (call: Call): Backend => ({
  async balance(a) {
    const r = await json<{ balanceSat: number; unconfirmedBalanceSat: number }>(call, `/address/details/${a}`)
    return sat(r.balanceSat + r.unconfirmedBalanceSat)
  },
  async coins(a) {
    const r = await json<{ utxos: { txid: string; vout: number; satoshis: number; confirmations?: number }[] }>(call, `/address/utxo/${a}`)
    return r.utxos.filter((u) => (u.confirmations ?? 0) > 0).map((u) => ({ txid: u.txid, vout: u.vout, value: sat(u.satoshis) }))
  },
  async broadcast(hex) {
    const res = await call(`/rawtransactions/sendRawTransaction/${hex}`)
    const body = (await res.text()).trim()
    // The node answers with the transaction id, as a JSON string or as plain text. Anything else, such as a
    // plain-text refusal ("txn-mempool-conflict"), must never be taken for an id: the transfer would look sent.
    let answer: unknown = body
    try {
      answer = JSON.parse(body)
    } catch {
      // plain text: checked below like a JSON string
    }
    if (!res.ok || typeof answer !== 'string' || !/^[0-9a-f]{64}$/i.test(answer)) throw new Error(`The node refused the transaction: ${body.slice(0, 300)}`)
    return answer
  },
  async confirmed(txid) {
    const res = await call(`/transaction/details/${txid}`)
    return res.ok && ((await res.json()) as { confirmations?: number }).confirmations! > 0
  },
})

const BACKENDS = { blockcypher, 'bch-rest': bchRest } as const

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Size of a transaction with plain inputs: 148 bytes each, 34 per standard output, 10 for the rest, and the memo output. */
const txSize = (inputs: number, memoBytes: number) => 10 + 148 * inputs + 34 + 34 + (memoBytes ? 11 + memoBytes : 0)

export function legacyUtxoAdapter(chain: Chain, coin: UtxoCoin, opts: { fetch: FetchFn; rpcUrl?: string; blockcypher?: boolean }): ChainAdapter {
  const backendFactory = BACKENDS[coin.backend as keyof typeof BACKENDS]
  if (!backendFactory) throw new Error(`${coin.name} has no data source`)
  const urls = opts.rpcUrl ? [opts.rpcUrl] : chain.rpcUrls.length ? chain.rpcUrls : coin.endpoints
  const codec = addressCodec(coin)
  const forkId = Boolean(coin.cashAddrPrefix)

  const call: Call = async (path, init) => {
    if (coin.backend === 'blockcypher' && !opts.rpcUrl && !opts.blockcypher) {
      throw new Error(
        `${chain.name} is read through BlockCypher, whose documentation asks for an API token on broadcasts. It is off until you allow it: chainer config set blockcypher on (or use your own endpoint: chainer config rpc ${chain.key} <url>)`,
      )
    }
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
  const backend = backendFactory(call)

  return {
    chain,
    validateAddress(address) {
      try {
        codec.decode(address)
        return true
      } catch {
        return false
      }
    },

    async getBalances(address, tokens) {
      const balance = await backend.balance(address)
      return tokens.map(() => balance)
    },

    async prepare() {},

    async send(action, signer: Signer) {
      if (action.kind === 'utxo-psbt') throw new Error(`${chain.name} cannot sign a PSBT from a route source; use a route that deposits to an address (THORChain, Maya)`)
      if (action.kind !== 'utxo-send') throw new Error(`${chain.name} cannot run a "${action.kind}" action`)
      if (!signer.seed) throw new Error(`This wallet has no ${chain.name} key: it was made from a single EVM private key`)
      const key = utxoKey(signer.seed, chain.key)
      const own = outputScript(codec.decode(key.address))
      const memo = action.memo ? new TextEncoder().encode(action.memo) : undefined
      if (memo && memo.length > 80) throw new Error('A memo longer than 80 bytes does not fit in a standard transaction')

      const recipient = outputScript(codec.decode(action.to))
      const coins = (await backend.coins(key.address)).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
      const rate = Math.max(coin.minFeeRate, (await backend.feeRate?.()) ?? 0)
      const feeFor = (inputs: number) => BigInt(Math.ceil(txSize(inputs, memo?.length ?? 0) * rate))

      const chosen: Coin[] = []
      let have = 0n
      for (const c of coins) {
        chosen.push(c)
        have += c.value
        if (have >= action.amount + feeFor(chosen.length)) break
      }
      const fee = feeFor(chosen.length)
      // With no usable coin at all, the need is stated with the fee of the one input a send takes at least.
      if (have < action.amount + fee) throw new Error(`Not enough ${chain.nativeSymbol}: need ${action.amount + feeFor(Math.max(1, chosen.length))} including the fee, the wallet holds ${have} (confirmed)`)
      if (fee > (action.amount * 5n) / 100n + coin.maxFeeFloor) throw new Error(`The network fee of ${fee} is too high for this amount right now`)

      const inputs: LegacyInput[] = chosen.map((c) => ({ txid: c.txid, vout: c.vout, value: c.value, script: own }))
      const outputs: LegacyOutput[] = [{ script: recipient, amount: action.amount }]
      if (memo) outputs.push({ script: dataScript(memo), amount: 0n })
      const change = have - action.amount - fee
      if (change >= coin.dust) outputs.push({ script: own, amount: change })
      const raw = signLegacyTx({ inputs, outputs, privateKey: key.privateKey, publicKey: key.publicKey, forkId })
      return backend.broadcast(bytesToHex(raw))
    },

    async waitForConfirmation(txId) {
      for (let i = 0; i < 6 * 60 * 2; i++) {
        if (await backend.confirmed(txId).catch(() => false)) return true
        await sleep(30_000)
      }
      throw new Error(`Transaction ${txId} is still unconfirmed after 6 hours. Check an explorer; it may have been dropped.`)
    },
  }
}
