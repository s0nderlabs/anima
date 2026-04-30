import type { Address } from 'viem'

import type { AnimaNetwork } from '../config'

/**
 * Canonical AnimaAgentNFT deployment addresses. CREATE2-deployed so both
 * networks share the same address; future deploys under different salts
 * would produce different addresses.
 */
export const ANIMA_AGENT_NFT_ADDRESS: Record<AnimaNetwork, Address> = {
  '0g-testnet': '0x9e71d79f06f956d4d2666b5c93dafab721c84721',
  '0g-mainnet': '0x9e71d79f06f956d4d2666b5c93dafab721c84721',
}

/**
 * Canonical AnimaInbox deployment address. Singleton A2A message emitter on
 * 0G Chain. CREATE2 deterministic via Arachnid's standard factory; same
 * address on both networks. Mainnet deploy tx:
 * 0xe8f1a32a4c713dd85edd56e38bac0ba1abffccbd8815d9199c0ef7759f957814
 */
export const ANIMA_INBOX_ADDRESS: Record<AnimaNetwork, Address> = {
  '0g-testnet': '0xcd92844cc0ec6Be0607B330D4BaCC707339f2589',
  '0g-mainnet': '0xcd92844cc0ec6Be0607B330D4BaCC707339f2589',
}

/**
 * Canonical AnimaMarket deployment address. Native-0G fixed-price escrow.
 * CREATE2 deterministic; same address on both networks. Mainnet deploy tx:
 * 0x72de913e0e8062255a4625ef0401ca06f825048e780759558bef48fada58e6b0
 * Fee recipient: dev.deployer (immutable).
 */
export const ANIMA_MARKET_ADDRESS: Record<AnimaNetwork, Address> = {
  '0g-testnet': '0x3ebD21f5dd67acDeF199fACF28388627212bA2aB',
  '0g-mainnet': '0x3ebD21f5dd67acDeF199fACF28388627212bA2aB',
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
