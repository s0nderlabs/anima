// Per-browser cache of agent EOAs keyed by iNFT tokenId.
// Populated by SANN reverse-lookup or by operator manual paste.
// Stored in localStorage so the second visit skips the lookup work.

import type { Address } from 'viem'

const KEY_PREFIX = 'anima.console.agent-eoa.'

export function readAgentEoa(tokenId: bigint): Address | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(KEY_PREFIX + tokenId.toString())
    if (!raw) return null
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null
    return raw as Address
  } catch {
    return null
  }
}

export function writeAgentEoa(tokenId: bigint, addr: Address) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(KEY_PREFIX + tokenId.toString(), addr)
  } catch {
    // ignore quota errors
  }
}

export function clearAgentEoa(tokenId: bigint) {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(KEY_PREFIX + tokenId.toString())
  } catch {
    // ignore
  }
}

export function isValidEoa(s: string): s is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(s)
}
