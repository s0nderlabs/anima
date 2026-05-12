// AnimaSubnameRegistrar event scan for "subnames the operator has claimed".
// We use this to reverse-map tokenId → agent EOA via the CARD text records
// published at register-time. See packages/core/src/naming/registrar.ts.

import { type Address, type Hex, type PublicClient, parseAbiItem } from 'viem'
import { SANN_RESOLVER_ABI } from './abi'
import { ANIMA_FIRST_MINT_BLOCK, ANIMA_REGISTRAR_ADDRESS, SANN_RESOLVER } from './chain'

export const subnameClaimedEvent = parseAbiItem(
  'event SubnameClaimed(string label, bytes32 indexed subnameNode, address indexed owner, address indexed claimer)',
)

export type ClaimedSubname = {
  label: string
  node: Hex
  owner: Address
}

export async function listSubnamesClaimedBy(
  client: PublicClient,
  operator: Address,
): Promise<ClaimedSubname[]> {
  // Some operators have subnames where claimer != owner (e.g. dev.deployer
  // claimed on behalf of someone). Query both indexed args, then dedupe.
  const [byOwner, byClaimer] = await Promise.all([
    client.getLogs({
      address: ANIMA_REGISTRAR_ADDRESS,
      event: subnameClaimedEvent,
      args: { owner: operator },
      fromBlock: ANIMA_FIRST_MINT_BLOCK,
      toBlock: 'latest',
    }),
    client.getLogs({
      address: ANIMA_REGISTRAR_ADDRESS,
      event: subnameClaimedEvent,
      args: { claimer: operator },
      fromBlock: ANIMA_FIRST_MINT_BLOCK,
      toBlock: 'latest',
    }),
  ])
  const seen = new Set<string>()
  const merged: ClaimedSubname[] = []
  for (const l of [...byOwner, ...byClaimer]) {
    const label = l.args.label as string
    if (seen.has(label)) continue
    seen.add(label)
    merged.push({
      label,
      node: l.args.subnameNode as Hex,
      owner: l.args.owner as Address,
    })
  }
  return merged
}

/**
 * For a given list of claimed subnames, find which one points at the given
 * iNFT tokenId via its `agent:inft` text record. Returns the subname's `address`
 * text record (the agent EOA) and the label.
 *
 * Text record format set by anima during init:
 *   agent:inft = "eip155:16661:0x9e71...4721:<tokenId>"
 */
export async function findAgentSubnameForToken(
  client: PublicClient,
  subnames: ClaimedSubname[],
  contractAddress: Address,
  tokenId: bigint,
): Promise<{ label: string; agentEOA: Address } | null> {
  const target = `eip155:16661:${contractAddress.toLowerCase()}:${tokenId.toString()}`
  const probes = await Promise.allSettled(
    subnames.map(async s => {
      const [inftRecord, addrRecord] = await Promise.all([
        client.readContract({
          address: SANN_RESOLVER,
          abi: SANN_RESOLVER_ABI,
          functionName: 'text',
          args: [s.node, 'agent:inft'],
        }),
        client.readContract({
          address: SANN_RESOLVER,
          abi: SANN_RESOLVER_ABI,
          functionName: 'text',
          args: [s.node, 'address'],
        }),
      ])
      return {
        label: s.label,
        inft: (inftRecord as string)?.toLowerCase(),
        addrText: addrRecord as string,
      }
    }),
  )
  for (const p of probes) {
    if (p.status !== 'fulfilled') continue
    if (!p.value.inft) continue
    if (p.value.inft === target.toLowerCase() && p.value.addrText) {
      return { label: p.value.label, agentEOA: p.value.addrText as Address }
    }
  }
  return null
}
