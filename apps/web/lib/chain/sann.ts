// SANN namehash + best-effort reverse-resolution for `<label>.anima.0g` subnames.
// Mirrors packages/core/src/naming/sann.ts.

import {
  type Address,
  type Hex,
  type PublicClient,
  encodeAbiParameters,
  keccak256,
  pad,
  stringToBytes,
  toHex,
} from 'viem'
import { SANN_RESOLVER_ABI } from './abi'
import { SANN_RESOLVER, SANN_TLD_IDENTIFIER } from './chain'

export function sannNamehash(tldIdentifier: bigint, tld: string, sub: string[]): Hex {
  const idBytes = pad(toHex(tldIdentifier), { size: 32 })
  const zero: Hex = `0x${'00'.repeat(32)}`
  const identifierNode = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [zero, idBytes]),
  )
  const tldHash = keccak256(stringToBytes(tld))
  let node = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [identifierNode, tldHash]),
  )
  for (const label of sub) {
    const labelHash = keccak256(stringToBytes(label))
    node = keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [node, labelHash]),
    )
  }
  return node
}

export function subnameNode(label: string): Hex {
  return sannNamehash(SANN_TLD_IDENTIFIER, '0g', ['anima', label])
}

const CARD_TEXT_KEYS = [
  'address',
  'agent:bio',
  'agent:skills',
  'agent:endpoints',
  'avatar',
  'agent:inft',
] as const
export type CardTextKey = (typeof CARD_TEXT_KEYS)[number]
export type CardTextRecords = Partial<Record<CardTextKey, string>>

/**
 * Read CARD text records for a known subname (e.g. "specter").
 * Returns empty object if any read fails.
 */
export async function readCardTextRecords(
  client: PublicClient,
  subnameLabel: string,
): Promise<CardTextRecords> {
  const node = subnameNode(subnameLabel)
  const entries = await Promise.allSettled(
    CARD_TEXT_KEYS.map(async key => {
      const v = (await client.readContract({
        address: SANN_RESOLVER,
        abi: SANN_RESOLVER_ABI,
        functionName: 'text',
        args: [node, key],
      })) as string
      return [key, v] as const
    }),
  )
  const out: CardTextRecords = {}
  for (const e of entries) {
    if (e.status === 'fulfilled') {
      const [k, v] = e.value
      if (v && v.length > 0) out[k] = v
    }
  }
  return out
}

/**
 * Resolve a subname label to its `addr` resolver record. Returns null if not set.
 */
export async function readSubnameAddr(
  client: PublicClient,
  subnameLabel: string,
): Promise<Address | null> {
  try {
    const node = subnameNode(subnameLabel)
    const addr = (await client.readContract({
      address: SANN_RESOLVER,
      abi: SANN_RESOLVER_ABI,
      functionName: 'addr',
      args: [node],
    })) as Address
    if (!addr || addr === '0x0000000000000000000000000000000000000000') return null
    return addr
  } catch {
    return null
  }
}
