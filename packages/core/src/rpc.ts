import type { Chain } from './types.ts'

/**
 * Default RPC endpoints per EVM chain id, in the order they are tried. Every host here was checked
 * on 16 Nov 2026: its terms (or, where none exist, its published limits) allow keyless use from an
 * application, and it answered `eth_chainId` with the right chain. The review is in docs/PLAN.md
 * ("RPC endpoints"); the saved pages are in docs/terms-evidence/rpc/.
 *
 *  1. PublicNode (Allnodes Inc.): its terms allow automated access "for development and production purposes".
 *  2. Pocket Network Foundation's public portal: free, keyless, published limits, no bot clause.
 *  3. dRPC public nodes: no registration needed; the terms name no rule against keyless RPC calls.
 *
 * A chain's own endpoint in LI.FI's list is only used when none of these three serves the chain.
 */
const REVIEWED_EVM_RPC: Record<number, string[]> = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.api.pocket.network', 'https://eth.drpc.org'], // eth
  10: ['https://optimism-rpc.publicnode.com', 'https://op.api.pocket.network', 'https://optimism.drpc.org'], // opt
  14: ['https://flare.drpc.org'], // flr
  25: ['https://cronos-evm-rpc.publicnode.com', 'https://cronos.drpc.org'], // cro
  30: ['https://rootstock.drpc.org'], // rsk
  40: ['https://telos.drpc.org'], // tlo
  56: ['https://bsc-rpc.publicnode.com', 'https://bsc.api.pocket.network'], // bsc
  88: ['https://viction.drpc.org'], // vic
  100: ['https://gnosis-rpc.publicnode.com', 'https://gnosis.api.pocket.network', 'https://gnosis.drpc.org'], // dai
  122: ['https://fuse.api.pocket.network', 'https://fuse.drpc.org'], // fus
  130: ['https://unichain-rpc.publicnode.com', 'https://unichain.api.pocket.network', 'https://unichain.drpc.org'], // uni
  137: ['https://polygon-bor-rpc.publicnode.com', 'https://poly.api.pocket.network', 'https://polygon.drpc.org'], // pol
  143: ['https://monad-mainnet.drpc.org'], // mon
  146: ['https://sonic-rpc.publicnode.com', 'https://sonic.api.pocket.network', 'https://sonic.drpc.org'], // son
  196: ['https://xlayer.drpc.org'], // xly
  252: ['https://fraxtal-rpc.publicnode.com', 'https://fraxtal.api.pocket.network', 'https://fraxtal.drpc.org'], // fra
  324: ['https://zksync-era.api.pocket.network', 'https://zksync.drpc.org'], // era
  480: ['https://worldchain.drpc.org'], // wcc
  988: ['https://stable-evm-rpc.publicnode.com', 'https://stable.drpc.org'], // sta
  999: ['https://hyperliquid-rpc.publicnode.com', 'https://hyperliquid.api.pocket.network', 'https://hyperliquid.drpc.org'], // hyp
  1088: ['https://metis-rpc.publicnode.com', 'https://metis.api.pocket.network', 'https://metis.drpc.org'], // mam
  1329: ['https://sei-evm-rpc.publicnode.com', 'https://sei.api.pocket.network', 'https://sei.drpc.org'], // sei
  1672: ['https://pharos.drpc.org'], // phr
  1776: ['https://injective-evm-rpc.publicnode.com', 'https://injective.drpc.org'], // inj
  1868: ['https://soneium-rpc.publicnode.com', 'https://soneium.drpc.org'], // soe
  2741: ['https://abstract.drpc.org'], // abs
  4217: ['https://tempo-rpc.publicnode.com', 'https://tempo-mainnet.drpc.org'], // tem
  4326: ['https://megaeth.drpc.org'], // meg
  4663: ['https://robinhood-rpc.publicnode.com', 'https://robinhood.drpc.org'], // out
  5000: ['https://mantle-rpc.publicnode.com', 'https://mantle.drpc.org'], // mnt
  5031: ['https://somnia-rpc.publicnode.com'], // som
  5042: ['https://arc-rpc.publicnode.com', 'https://arc.drpc.org'], // arc
  8217: ['https://kaia.api.pocket.network'], // kai
  8453: ['https://base-rpc.publicnode.com', 'https://base.api.pocket.network', 'https://base.drpc.org'], // bas
  13371: ['https://immutable-zkevm.drpc.org'], // imx
  16661: ['https://0g-rpc.publicnode.com', 'https://0g-mainnet.drpc.org'], // zerog
  33139: ['https://apechain.drpc.org'], // ape
  34443: ['https://mode.drpc.org'], // mod
  42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb-one.api.pocket.network', 'https://arbitrum.drpc.org'], // arb
  42170: ['https://arbitrum-nova-rpc.publicnode.com', 'https://arbitrum-nova.drpc.org'], // arn
  42220: ['https://celo-rpc.publicnode.com', 'https://celo.api.pocket.network', 'https://celo.drpc.org'], // cel
  43111: ['https://hemi.drpc.org'], // hmi
  43114: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://avax.api.pocket.network', 'https://avalanche.drpc.org'], // ava
  57073: ['https://ink-rpc.publicnode.com', 'https://ink.api.pocket.network', 'https://ink.drpc.org'], // ink
  59144: ['https://linea-rpc.publicnode.com', 'https://linea.api.pocket.network', 'https://linea.drpc.org'], // lna
  80094: ['https://berachain-rpc.publicnode.com', 'https://bera.api.pocket.network', 'https://berachain.drpc.org'], // ber
  84532: ['https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia-testnet.api.pocket.network'], // bast
  98866: ['https://plume.drpc.org'], // plu
  99901: ['https://elysium-rpc.publicnode.com', 'https://elysium.drpc.org'], // ely
  421614: ['https://arbitrum-sepolia-rpc.publicnode.com', 'https://arb-sepolia-testnet.api.pocket.network'], // arbs
  534352: ['https://scroll-rpc.publicnode.com', 'https://scroll.api.pocket.network', 'https://scroll.drpc.org'], // scl
  747474: ['https://katana.drpc.org'], // kat
  5042002: ['https://arc-testnet-rpc.publicnode.com'], // arct
  11155111: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://eth-sepolia-testnet.api.pocket.network'], // eths
  11155420: ['https://optimism-sepolia-rpc.publicnode.com', 'https://op-sepolia-testnet.api.pocket.network'], // opst
}

/**
 * Solana (LI.FI's chain id for it). PublicNode and Pocket first; the Solana Labs endpoint last, since its
 * documentation says the public endpoints are rate-limited and meant for users and developers, with
 * paid providers for production infrastructure.
 */
const SOLANA_RPC = ['https://solana-rpc.publicnode.com', 'https://solana.api.pocket.network', 'https://api.mainnet.solana.com']
const SOLANA_ID = 1151111081099710

/**
 * Endpoints LI.FI lists whose operators say they are not for production use of applications
 * (the Base, Arbitrum and Optimism public RPCs) or that were superseded (Solana's old hostname).
 */
const NOT_FOR_APPS = new Set([
  'mainnet.base.org',
  'sepolia.base.org',
  'arb1.arbitrum.io',
  'sepolia-rollup.arbitrum.io',
  'mainnet.optimism.io',
  'sepolia.optimism.io',
  'api.mainnet-beta.solana.com',
])

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** The endpoints to use for a chain unless the user set their own: reviewed hosts first, then the chain's own from LI.FI. */
export function defaultRpcUrls(chain: Pick<Chain, 'family' | 'id'>, listed: string[]): string[] {
  const reviewed = chain.family === 'solana' && chain.id === SOLANA_ID ? SOLANA_RPC : chain.family === 'evm' ? REVIEWED_EVM_RPC[chain.id] : undefined
  if (reviewed) return reviewed
  return listed.filter((url) => !NOT_FOR_APPS.has(hostOf(url)))
}
