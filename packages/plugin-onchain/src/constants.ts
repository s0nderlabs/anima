/**
 * Mainnet-verified contract addresses for 0G Aristotle (chain 16661).
 * All four core protocols below were probed live on May 1 2026 with successful
 * txs; see memory `phase-10-design-locked.md` for the cast verifications.
 */

import type { AnimaNetwork } from '@s0nderlabs/anima-core'
import type { Address } from 'viem'

/** Multicall3 universal address — same on every EVM chain that has it. */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

/** JAINE protocol contracts (Uniswap V3 softfork on 0G). */
export interface JaineAddresses {
  factory: Address
  swapRouter: Address
  quoter: Address
  weth9: Address
}

/** Gimo liquid-staking pool. */
export interface GimoAddresses {
  pool: Address
  stog: Address
}

export const JAINE_BY_NETWORK: Record<AnimaNetwork, JaineAddresses | null> = {
  '0g-mainnet': {
    factory: '0x9bdcA5798E52e592A08e3b34d3F18EeF76Af7ef4',
    swapRouter: '0x8B598A7C136215A95ba0282b4d832B9f9801f2e2',
    quoter: '0xd00883722cECAD3A1c60bCA611f09e1851a0bE02',
    weth9: '0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c',
  },
  '0g-testnet': null, // Not deployed; testnet uses different addresses (chain 16601 deployment)
}

export const GIMO_BY_NETWORK: Record<AnimaNetwork, GimoAddresses | null> = {
  '0g-mainnet': {
    pool: '0xac06d1df23a4fa00981afac0f33a5936bd2135af',
    stog: '0x7bbc63d01ca42491c3e084c941c3e86e55951404',
  },
  '0g-testnet': null,
}

/** JAINE V3 fee tiers in increasing order (1 bp = 0.01%). */
export const FEE_TIERS = [500, 3000, 10000] as const
export type FeeTier = (typeof FEE_TIERS)[number]

/** Default swap deadline: 10 minutes. */
export const DEFAULT_DEADLINE_SECS = 600n

/** Default slippage tolerance (50 bps = 0.5%). */
export const DEFAULT_SLIPPAGE_BPS = 50

/** Hard floor for Gimo stake; below this `pool.stake()` reverts with 0x41524be2. */
export const MIN_STAKE_WEI = 10_000_000_000_000_000n // 0.01 0G

/** Gimo unstake cooldown observed across 8 user pairs: 63-74h, ~72h centroid. */
export const GIMO_COOLDOWN_SECS = 72n * 60n * 60n

/** Block-range chunk size for `eth_getLogs`. 50k chunks safe on 0G mainnet RPC. */
export const LOG_SCAN_CHUNK_BLOCKS = 50_000n

/** keccak256("Transfer(address,address,uint256)") — ERC-20/721 Transfer topic0. */
export const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const

/** Max chunks per `chain.balance` discovery scan = 1.5M block ceiling. */
export const LOG_SCAN_MAX_CHUNKS = 30

/** EIP-1967 implementation slot for proxy detection. */
export const EIP1967_IMPL_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const

/** ERC-165 interface IDs anima checks via `chain.contract`. */
export const ERC165_INTERFACES = {
  ERC721: '0x80ac58cd',
  ERC1155: '0xd9b67a26',
  ERC721Metadata: '0x5b5e139f',
  ERC721Enumerable: '0x780e9d63',
} as const

/** Symbols the brain may say in lieu of "native" / address. */
export const NATIVE_ALIASES = new Set(['0G', 'OG', 'native', '0g', 'og'])

/** Gimo's `withdraw()` revert selector for cooldown-not-elapsed. */
export const GIMO_COOLDOWN_REVERT_SELECTOR = '0xd6d9e665'

/** Gimo's `stake()` revert selector for below-min-stake. */
export const GIMO_MIN_STAKE_REVERT_SELECTOR = '0x41524be2'

/** Convenience guard that throws if the network has no JAINE/Gimo deployment. */
export function requireMainnet(network: AnimaNetwork): asserts network is '0g-mainnet' {
  if (network !== '0g-mainnet') {
    throw new Error(
      `plugin-onchain currently supports 0g-mainnet only (got ${network}). JAINE + Gimo aren't deployed on testnet.`,
    )
  }
}
