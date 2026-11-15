import { getAddMemoInstruction } from '@solana-program/memo'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  isAddress,
  lamports,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from '@solana/kit'
import { solanaSecretKey } from '../derive.ts'
import { isNative } from '../tokens.ts'
import type { Chain, ChainAdapter, FetchFn, Signer } from '../types.ts'

/** Token-2022 (token extensions) program; classic SPL tokens use TOKEN_PROGRAM_ADDRESS. */
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address

interface RpcReply<T> {
  result?: T
  error?: { code: number; message: string }
}

/** Minimal JSON-RPC client that tries each endpoint in turn. */
function rpcClient(urls: string[], fetchFn: FetchFn) {
  return async function call<T>(method: string, params: unknown[] = []): Promise<T> {
    let last: Error = new Error('No RPC endpoint')
    for (const url of urls) {
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
        const body = (await res.json().catch(() => ({}))) as RpcReply<T>
        if (body.error) {
          // A reply from the chain (bad transaction, ...) is final; another endpoint would say the same.
          throw Object.assign(new Error(body.error.message), { final: true })
        }
        if (!res.ok || body.result === undefined) throw new Error(`${new URL(url).host} responded ${res.status}`)
        return body.result
      } catch (err) {
        if ((err as { final?: boolean }).final) throw err
        last = err as Error
      }
    }
    throw last
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function solanaAdapter(chain: Chain, opts: { fetch: FetchFn; rpcUrl?: string }): ChainAdapter {
  const urls = opts.rpcUrl ? [opts.rpcUrl] : chain.rpcUrls
  if (urls.length === 0) throw new Error(`No RPC endpoint known for ${chain.name}; set one with "chainer config rpc ${chain.key} <url>"`)
  const rpc = rpcClient(urls, opts.fetch)

  const keyPair = async (signer: Signer) => {
    if (!signer.seed) throw new Error('This wallet has no Solana key: it was made from a single EVM private key')
    return createKeyPairSignerFromPrivateKeyBytes(solanaSecretKey(signer.seed))
  }

  const broadcast = async (wire: string): Promise<string> =>
    rpc<string>('sendTransaction', [wire, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }])

  return {
    chain,
    validateAddress: (a) => isAddress(a),

    async getBalances(owner, tokens) {
      const wantsSol = tokens.some(isNative)
      const [sol, classic, extended] = await Promise.all([
        wantsSol ? rpc<{ value: number }>('getBalance', [owner, { commitment: 'confirmed' }]) : { value: 0 },
        tokens.length > (wantsSol ? 1 : 0) ? tokenBalances(owner, TOKEN_PROGRAM_ADDRESS) : new Map<string, bigint>(),
        tokens.length > (wantsSol ? 1 : 0) ? tokenBalances(owner, TOKEN_2022) : new Map<string, bigint>(),
      ])
      return tokens.map((t) => (isNative(t) ? BigInt(sol.value) : (classic.get(t.address) ?? 0n) + (extended.get(t.address) ?? 0n)))
    },

    async prepare() {},

    async send(action, signer) {
      const payer = await keyPair(signer)
      if (action.kind === 'solana-tx') {
        const bytes = getBase64Encoder().encode(action.transaction)
        const tx = getTransactionDecoder().decode(bytes)
        if (!(payer.address in tx.signatures)) throw new Error('The route asks for a signature from an address that is not this wallet; refusing to sign')
        const signed = await partiallySignTransaction([payer.keyPair], tx)
        return broadcast(getBase64EncodedWireTransaction(signed))
      }
      if (action.kind !== 'solana-transfer') throw new Error(`Solana cannot run a "${action.kind}" action`)

      const destination = address(action.to)
      const instructions: Instruction[] = []
      if (!action.mint) {
        instructions.push(getTransferSolInstruction({ source: payer, destination, amount: lamports(action.amount) }))
      } else {
        const mint = address(action.mint)
        const mintInfo = await rpc<{ value: { owner: string; data: { parsed: { info: { decimals: number } } } } | null }>('getAccountInfo', [action.mint, { encoding: 'jsonParsed' }])
        if (!mintInfo.value) throw new Error(`Token ${action.mint} does not exist on ${chain.name}`)
        const tokenProgram = mintInfo.value.owner as Address
        const [source] = await findAssociatedTokenPda({ owner: payer.address, mint, tokenProgram })
        const [target] = await findAssociatedTokenPda({ owner: destination, mint, tokenProgram })
        instructions.push(
          getCreateAssociatedTokenIdempotentInstruction({ payer, ata: target, owner: destination, mint, tokenProgram }),
          getTransferCheckedInstruction(
            { source, mint, destination: target, authority: payer, amount: action.amount, decimals: mintInfo.value.data.parsed.info.decimals },
            { programAddress: tokenProgram },
          ),
        )
      }
      if (action.memo) instructions.push(getAddMemoInstruction({ memo: action.memo }))

      const { value: blockhash } = await rpc<{ value: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0] }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      )
      const signed = await signTransactionMessageWithSigners(message)
      return broadcast(getBase64EncodedWireTransaction(signed))
    },

    async waitForConfirmation(txId) {
      // A transaction that never lands stops being valid after about 90 seconds; wait a bit longer than that.
      for (let i = 0; i < 80; i++) {
        const { value } = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[txId], { searchTransactionHistory: true }])
        const status = value[0]
        if (status?.err) return false
        if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return true
        await sleep(2000)
      }
      throw new Error(`Transaction ${txId} was not seen on ${chain.name} after waiting; it may not have been accepted. Check an explorer before sending again.`)
    },
  }

  async function tokenBalances(owner: string, programId: string): Promise<Map<string, bigint>> {
    const { value } = await rpc<{ value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }[] }>('getTokenAccountsByOwner', [
      owner,
      { programId },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ])
    const sums = new Map<string, bigint>()
    for (const { account } of value) {
      const { mint, tokenAmount } = account.data.parsed.info
      sums.set(mint, (sums.get(mint) ?? 0n) + BigInt(tokenAmount.amount))
    }
    return sums
  }
}
