import type { Address } from 'viem'

import type { AnimaNetwork } from '../config'

/**
 * Canonical AnimaAgentNFT deployment addresses per network. Both deploys are
 * permanent; future redeploys get new addresses (intentional — CREATE, not CREATE2).
 */
export const ANIMA_AGENT_NFT_ADDRESS: Record<AnimaNetwork, Address> = {
  '0g-testnet': '0xf132201d895f9a5d8b8dc4af2f7f8f9fc45935b1',
  '0g-mainnet': '0x1a60a42c1f8620638c2eac56deb2a4dfa08ab232',
}

export const EXPLORER_BASE: Record<AnimaNetwork, string> = {
  '0g-mainnet': 'https://chainscan.0g.ai',
  '0g-testnet': 'https://chainscan-galileo.0g.ai',
}

export type NetworkName = AnimaNetwork

export function explorerTxUrl(network: AnimaNetwork, txHash: string): string {
  return `${EXPLORER_BASE[network]}/tx/${txHash}`
}

export function explorerTokenUrl(network: AnimaNetwork, contract: string, tokenId: bigint): string {
  return `${EXPLORER_BASE[network]}/token/${contract}/${tokenId}`
}
