/** Standard worlds shared by the CLI and GUI tests. */
import { ZERO, type World } from './world.ts'

/** The test seed's first Ethereum account (BIP-44 test vector), which holds the funds below. */
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

// ---- a standard world ----

const USDC = (chain: string, n: number) => ({ chain, symbol: 'USDC', address: `0x${String(n).repeat(40)}`.slice(0, 42), decimals: 6, price: 1, name: 'USD Coin' })
export const TOKENS = {
  usdcEth: USDC('eth', 1),
  usdcArb: USDC('arb', 2),
  usdcBas: USDC('bas', 3),
  usdcArbs: USDC('arbs', 4),
  usdcBast: USDC('bast', 5),
  link: { chain: 'eth', symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18, price: 15, name: 'Chainlink' },
}

/**
 * Ethereum, Arbitrum and Base with USDC (and LINK on Ethereum), their test networks, the wallet
 * holding 1 ETH on Ethereum and 1 000 USDC on Arbitrum, and USDC Arbitrum -> Base by "stargate".
 */
export function standardWorld(over: Partial<World> = {}): World {
  return {
    chains: [
      { key: 'eth', id: 990001, name: 'Ethereum', coin: 'ETH', price: 3000 },
      { key: 'arb', id: 990002, name: 'Arbitrum', coin: 'ETH', price: 3000 },
      { key: 'bas', id: 990003, name: 'Base', coin: 'ETH', price: 3000 },
      { key: 'eths', id: 990011, name: 'Ethereum Sepolia', coin: 'ETH', price: 3000, mainnet: false },
      { key: 'arbs', id: 990012, name: 'Arbitrum Sepolia', coin: 'ETH', price: 3000, mainnet: false },
      { key: 'bast', id: 990013, name: 'Base Sepolia', coin: 'ETH', price: 3000, mainnet: false },
    ],
    tokens: Object.values(TOKENS),
    balances: { [ME]: { [`eth:${ZERO}`]: '1000000000000000000', [`arb:${TOKENS.usdcArb.address}`]: '1000000000', [`arb:${ZERO}`]: '10000000000000000', [`bas:${ZERO}`]: '10000000000000000' } },
    routes: [{ from: 'USDC@arb', to: 'USDC@bas', tool: 'stargate', rate: 0.999, gasUsd: 0.05, seconds: 60 }],
    ...over,
  }
}
