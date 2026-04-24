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
 * batched per section 27.5 firing policy.
 *
 * Uploads run SEQUENTIALLY even though they're logically independent: the
 * upstream `@0gfoundation/0g-ts-sdk` uses ethers with auto-managed nonces,
 * and concurrent writes from the same wallet race on nonce reservation
 * (`nonce too low`). Correctness over speed; the single batched `update()`
 * at the end keeps on-chain cost bounded.
 */
export async function syncMemory(opts: SyncMemoryOpts): Promise<SyncMemoryResult> {
  const targets = opts.targets ?? defaultSyncTargets(opts.agentId)
  const uploads: { slot: IntelligentDataSlot; rootHash: string }[] = []
  const updates: UpdateSlot[] = []

  for (const target of targets) {
    if (target.slot === 'activity-log') continue
    const path = target.slot === 'keystore' ? opts.keystorePath : target.path
    if (!path) continue
    const bytes = await readOrNull(path)
    if (!bytes) continue
    const payload =
      target.slot === 'keystore' ? bytes : packEnvelope(encrypt(bytes, opts.passphrase))
    const rootHash = await opts.storage.putBlob(payload)
    uploads.push({ slot: target.slot, rootHash })
    updates.push({ slot: target.slot, dataHash: keccak256(payload) })
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
