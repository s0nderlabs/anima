import type { Address } from 'viem'

import type { AnimaNetwork } from '../config'

/**
 * Canonical AnimaAgentNFT deployment addresses. CREATE2-deployed so both
 * networks share the same address; future deploys under different salts
 * would produce different addresses.
 */
export const ANIMA_AGENT_NFT_ADDRESS: Record<AnimaNetwork, Address> = {
  '0g-testnet': '0xc2e3d0daac03fa525ebffa3ab0ddb80ef26fcc7f',
  '0g-mainnet': '0xc2e3d0daac03fa525ebffa3ab0ddb80ef26fcc7f',
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
