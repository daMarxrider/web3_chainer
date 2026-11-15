import { zeroAddress } from 'viem'
import type { Token } from './types.ts'

/** Addresses that stand for a chain's own coin: EVM zero address, Solana system program, LI.FI's names for UTXO coins. */
const NATIVE_ADDRESSES = new Set([zeroAddress, '11111111111111111111111111111111', 'bitcoin', 'litecoin', 'zcash', 'dogecoin', 'bitcoincash', 'dash'])

export const isNative = (token: Pick<Token, 'address'>) => NATIVE_ADDRESSES.has(token.address.toLowerCase())
