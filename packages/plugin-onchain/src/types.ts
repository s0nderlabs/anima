/**
 * Public types exported from plugin-onchain. The runtime context follows the
 * same side-band pattern as `plugin-comms/src/index.ts:CommsRuntimeContext`:
 * the harness builds it in `chat.tsx`, the plugin reads it via
 * `(ctx as any).onchain`. Keeps PluginContext clean of plugin-specific fields.
 */

import type { AnimaNetwork } from '@s0nderlabs/anima-core'
import type { Address } from 'viem'

export interface OnchainRuntimeContext {
  agentEoa: Address
  network: AnimaNetwork
  publicClient: import('viem').PublicClient
  walletClient: import('viem').WalletClient
  agentDir: string
  /** iNFT mint block — used as floor for Transfer-event discovery scans. */
  mintBlock: bigint
  iNFT?: { contract: Address; tokenId: bigint }
  /** Optional: brain provider/model for account.info bundling. */
  brainProvider?: string | null
  brainModel?: string | null
  /** Optional: live compute ledger balance reader. */
  brokerLedger?: { balance0G: () => Promise<number | null> }
}

export interface TokenInfo {
  address: Address
  symbol: string
  name?: string
  decimals: number
  /** Where this entry came from. */
  source: 'cache' | 'list' | 'onchain' | 'native'
}

export interface NativeBalance {
  raw: string // bigint serialized as decimal string
  formatted: string // human "1.234"
}

export interface TokenBalance extends TokenInfo {
  raw: string
  formatted: string
}

export interface BalanceSnapshot {
  address: Address
  native: NativeBalance
  tokens: TokenBalance[]
  /** Block at which the snapshot was taken. */
  blockNumber: number
}
