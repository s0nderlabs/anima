import { readFile } from 'node:fs/promises'
import { type Address, type Hex, keccak256 } from 'viem'
import { agentPaths } from '../paths'
import { AnimaAgentNFTClient, bootstrapHashFor, buildMintEntries } from './contract'
import { ANIMA_AGENT_NFT_ADDRESS, type NetworkName } from './deployments'
import type { IntelligentDataEntry, MintResult } from './intelligent-data'

export interface MintAgentOpts {
  network: NetworkName
  privkeyHex: Hex
  /** The EOA to mint the iNFT to. Usually the same as privkeyHex's account. */
  to: Address
  /** Path to the encrypted keystore file. Hash becomes the real value for the "keystore" slot. */
  keystorePath: string
}

export async function mintAgent(opts: MintAgentOpts): Promise<{
  result: MintResult
  entries: IntelligentDataEntry[]
  contractAddress: Address
}> {
  const contractAddress = ANIMA_AGENT_NFT_ADDRESS[opts.network]
  const keystoreBytes = await readFile(opts.keystorePath)
  const keystoreHash = keccak256(new Uint8Array(keystoreBytes)) as Hex

  const entries = buildMintEntries({ keystore: keystoreHash })

  const client = new AnimaAgentNFTClient({
    network: opts.network,
    contractAddress,
    privkeyHex: opts.privkeyHex,
  })
  const result = await client.mint({ to: opts.to, iDatas: entries })
  return { result, entries, contractAddress }
}

export interface DerivedAgentIdOpts {
  contractAddress: string
  tokenId: bigint
}

/**
 * Derive the per-agent id used for the on-disk agent state directory.
 * Post-mint agents key off (contract, tokenId) hash; pre-mint agents fall back
 * to `placeholderAgentId(eoaAddress)` so runtime has something stable either way.
 */
export function iNFTAgentId(opts: DerivedAgentIdOpts): string {
  const packed = `${opts.contractAddress.toLowerCase()}:${opts.tokenId.toString()}`
  return keccak256(new TextEncoder().encode(packed)).slice(2, 18)
}

export { agentPaths }
export { bootstrapHashFor }
