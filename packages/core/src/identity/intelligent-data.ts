import type { Hex } from 'viem'

/**
 * Canonical IntelligentData slots per project-anima.md section 26.3.
 * One entry per logical file on-chain. Emergent topic files do NOT get
 * their own slots; they're enumerated inside MEMORY.md's index and
 * therefore covered by slot 0's dataHash.
 */
export const INTELLIGENT_DATA_SLOTS = [
  'memory-index',
  'identity',
  'persona',
  'profile',
  'keystore',
  'activity-log',
] as const

export type IntelligentDataSlot = (typeof INTELLIGENT_DATA_SLOTS)[number]

export interface IntelligentDataEntry {
  dataDescription: IntelligentDataSlot
  dataHash: Hex
}

export interface MintParams {
  to: Hex
  iDatas: IntelligentDataEntry[]
}

export interface MintResult {
  tokenId: bigint
  txHash: Hex
  blockNumber: bigint
}

export interface UpdateSlot {
  slot: IntelligentDataSlot
  dataHash: Hex
}

export function slotIndex(slot: IntelligentDataSlot): number {
  return INTELLIGENT_DATA_SLOTS.indexOf(slot)
}

export function slotByIndex(idx: number): IntelligentDataSlot {
  const name = INTELLIGENT_DATA_SLOTS[idx]
  if (!name) throw new Error(`unknown slot index ${idx} (max ${INTELLIGENT_DATA_SLOTS.length - 1})`)
  return name
}
