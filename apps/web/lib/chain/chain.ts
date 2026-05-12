import { defineChain } from 'viem'

/**
 * 0G Chain mainnet. ChainId 16661.
 * Multicall3 not confirmed deployed; viem will fall back to sequential
 * eth_call when multicall reads are requested.
 */
export const zgMainnet = defineChain({
  id: 16661,
  name: '0G Chain',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://evmrpc.0g.ai'] },
  },
  blockExplorers: {
    default: { name: '0G Scan', url: 'https://chainscan.0g.ai' },
  },
})

export const zgTestnet = defineChain({
  id: 16602,
  name: '0G Galileo Testnet',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://evmrpc-testnet.0g.ai'] },
  },
  blockExplorers: {
    default: { name: '0G Galileo Scan', url: 'https://chainscan-galileo.0g.ai' },
  },
})

export const ANIMA_AGENT_NFT_ADDRESS = '0x9e71d79f06f956d4d2666b5c93dafab721c84721' as const
export const ANIMA_INBOX_ADDRESS = '0xcd92844cc0ec6Be0607B330D4BaCC707339f2589' as const
export const ANIMA_MARKET_ADDRESS = '0x3ebD21f5dd67acDeF199fACF28388627212bA2aB' as const

// SANN naming on 0G mainnet.
export const SANN_REGISTRY = '0x5dC881dDA4e4a8d312be3544AD13118D1a04Cb17' as const
export const SANN_RESOLVER = '0x6D3B3F99177FB2A5de7F9E928a9BD807bF7b5BAD' as const
export const SANN_TLD_IDENTIFIER =
  449205675366457712613706471770511817162982777845754732038879201565074548n

// Permissionless `<label>.anima.0g` subname registrar.
// Mirrors packages/core/src/naming/registrar.ts.
export const ANIMA_REGISTRAR_ADDRESS = '0x33d9f4ec2bd7e7cb4e288c3bbc3a76be472fdd98' as const

// Earliest known activity block on mainnet. Set just below the first known
// anima mint (block 31_560_769 for specter). 0G RPC caps `eth_getLogs` ranges
// so going wider triggers silent failures; keep the floor tight.
export const ANIMA_FIRST_MINT_BLOCK = 31_500_000n

export const INTELLIGENT_DATA_SLOTS = [
  'memory-index',
  'identity',
  'persona',
  'profile',
  'keystore',
  'activity-log',
] as const

export type IntelligentDataSlot = (typeof INTELLIGENT_DATA_SLOTS)[number]

export function explorerTxUrl(tx: string): string {
  return `https://chainscan.0g.ai/tx/${tx}`
}

export function explorerAddrUrl(addr: string): string {
  return `https://chainscan.0g.ai/address/${addr}`
}

export function explorerTokenUrl(contract: string, tokenId: bigint | number | string): string {
  return `https://chainscan.0g.ai/token/${contract}/${tokenId}`
}
