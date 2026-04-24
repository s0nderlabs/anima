import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Hex, keccak256 } from 'viem'
import type { AnimaAgentNFTClient } from '../identity/contract'
import type { IntelligentDataSlot, UpdateSlot } from '../identity/intelligent-data'
import { agentPaths } from '../paths'
import { encrypt, packEnvelope } from '../storage/encryption'
import type { OGStorage } from '../storage/og'

export interface SyncTarget {
  slot: IntelligentDataSlot
  /** Path relative to the agent's memory root. */
  path: string | null
}

/** Default mapping of IntelligentData slots to local memory files. */
export function defaultSyncTargets(agentId: string): SyncTarget[] {
  const memDir = agentPaths.agent(agentId).memoryDir
  return [
    { slot: 'memory-index', path: join(memDir, 'MEMORY.md') },
    { slot: 'identity', path: join(memDir, 'agent', 'identity.md') },
    { slot: 'persona', path: join(memDir, 'agent', 'persona.md') },
    { slot: 'profile', path: join(memDir, 'user', 'profile.md') },
    { slot: 'keystore', path: null },
    { slot: 'activity-log', path: null },
  ]
}

export interface SyncMemoryOpts {
  agentId: string
  tokenId: bigint
  passphrase: string
  storage: OGStorage
  nft: AnimaAgentNFTClient
  keystorePath: string
  /** Optional custom slot list (defaults to `defaultSyncTargets`). */
  targets?: SyncTarget[]
}

export interface SyncMemoryResult {
  updates: UpdateSlot[]
  txHash: Hex | null
  uploads: { slot: IntelligentDataSlot; rootHash: string }[]
}

/**
 * Encrypt + upload each memory file (if changed since last sync), compute
 * new slot hashes, and fire one `iNFT.update()` tx with all slot updates
 * batched per section 27.5 firing policy. Uploads run concurrently since
 * blobs are independent; the single update tx batches all slot hashes.
 */
export async function syncMemory(opts: SyncMemoryOpts): Promise<SyncMemoryResult> {
  const targets = opts.targets ?? defaultSyncTargets(opts.agentId)

  const prepared = await Promise.all(
    targets.map(async target => {
      if (target.slot === 'activity-log') return null // activity log sync is separate
      const path = target.slot === 'keystore' ? opts.keystorePath : target.path
      if (!path) return null
      const bytes = await readOrNull(path)
      if (!bytes) return null
      const payload =
        target.slot === 'keystore' ? bytes : packEnvelope(encrypt(bytes, opts.passphrase))
      const rootHash = await opts.storage.putBlob(payload)
      return {
        slot: target.slot,
        rootHash,
        dataHash: keccak256(payload),
      }
    }),
  )

  const uploads: { slot: IntelligentDataSlot; rootHash: string }[] = []
  const updates: UpdateSlot[] = []
  for (const item of prepared) {
    if (!item) continue
    uploads.push({ slot: item.slot, rootHash: item.rootHash })
    updates.push({ slot: item.slot, dataHash: item.dataHash })
  }

  if (updates.length === 0) {
    return { updates, txHash: null, uploads }
  }
  const txHash = await opts.nft.updateSlots(opts.tokenId, updates)
  return { updates, txHash, uploads }
}

async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    const buf = await readFile(path)
    return new Uint8Array(buf)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
