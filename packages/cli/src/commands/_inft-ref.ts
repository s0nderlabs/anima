import { type AnimaNetwork, NETWORK_CHAIN_ID, networkFromChainId } from '@s0nderlabs/anima-core'
import type { Address } from 'viem'

/**
 * Parse a CAIP-style or 0G-flavor iNFT ref string into its parts. Used by
 * `anima restore` and `anima inspect` to take a single positional argument
 * pointing at any iNFT on either 0G network.
 *
 * Accepted forms:
 *   `eip155:<chainId>:0xCONTRACT:<tokenId>`
 *   `0g-mainnet:0xCONTRACT:<tokenId>`
 *   `0g-testnet:0xCONTRACT:<tokenId>`
 */
export interface ParsedINFTRef {
  network: AnimaNetwork
  contract: Address
  tokenId: bigint
}

export function parseINFTRef(ref: string): ParsedINFTRef {
  const parts = ref.split(':')
  if (parts.length === 4 && parts[0] === 'eip155') {
    const chainId = Number(parts[1])
    const contract = parts[2] as Address
    const tokenId = BigInt(parts[3]!)
    const network = networkFromChainId(chainId)
    if (!network) {
      const known = Object.values(NETWORK_CHAIN_ID).join(' or ')
      throw new Error(`Unknown chain id ${chainId} (expected ${known})`)
    }
    return { network, contract, tokenId }
  }
  if (parts.length === 3 && (parts[0] === '0g-mainnet' || parts[0] === '0g-testnet')) {
    return {
      network: parts[0] as AnimaNetwork,
      contract: parts[1] as Address,
      tokenId: BigInt(parts[2]!),
    }
  }
  throw new Error(
    `Unrecognized iNFT ref '${ref}'. Expected 'eip155:<chain>:0xCONTRACT:<tokenId>' or '0g-mainnet:0xCONTRACT:<tokenId>'.`,
  )
}
