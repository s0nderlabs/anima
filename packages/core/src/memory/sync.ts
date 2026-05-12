import { join } from 'node:path'
import { type Hex, keccak256 } from 'viem'
import type { AnimaAgentNFTClient } from '../identity/contract'
import type { IntelligentDataSlot, UpdateSlot } from '../identity/intelligent-data'
import { agentPaths } from '../paths'
import type { OGStorage } from '../storage/og'
import { deriveMemoryKey, encryptMemoryBytes } from './encryption'
import { readOrNull } from './fs-util'

export interface SyncTarget {
  slot: IntelligentDataSlot
  /** Absolute path to the local memory file. */
  path: string
}

/**
 * Default mapping of agent-anchored IntelligentData slots to local memory
 * files. Phase 6.7: keystore is owned by the keystore-blob path (Phase 6.6),
 * activity-log is owned by `activity-sync.ts`, profile slot is reserved for
 * the agent's public bio (post-MVP). User-partition files (`/user/*`) live
 * on 0G Storage but are NEVER anchored on chain.
 */
export function defaultMemorySyncTargets(
  agentId: string,
  memoryDirOverride?: string,
): SyncTarget[] {
  // Callers in the gateway daemon write memory under a tmpdir-based agent
  // state path (`${TMPDIR}/anima-gateway/<id>/memory/`), not the legacy
  // `~/.anima/agents/<id>/memory/`. When the daemon's agentDir differs,
  // pass `memoryDirOverride` so /sync reads + uploads the live memory tree
  // instead of stale on-disk leftovers from a prior embedded run.
  const memDir = memoryDirOverride ?? agentPaths.agent(agentId).memoryDir
  return [
    { slot: 'memory-index', path: join(memDir, 'MEMORY.md') },
    { slot: 'identity', path: join(memDir, 'agent', 'identity.md') },
    { slot: 'persona', path: join(memDir, 'agent', 'persona.md') },
  ]
}

export interface SyncMemoryOpts {
  tokenId: bigint
  agentPrivkey: Hex
  storage: OGStorage
  nft: AnimaAgentNFTClient
  /** Slots + file paths to sync. Caller is expected to pre-filter to only changed files. */
  targets: SyncTarget[]
}

export interface SyncMemoryResult {
  updates: UpdateSlot[]
  txHash: Hex | null
  uploads: { slot: IntelligentDataSlot; rootHash: string; plaintextHash: Hex }[]
}

/**
 * Encrypt + upload each provided memory file, then fire one batched
 * `iNFT.update()` covering all slot changes. No-op (no chain tx) if `targets`
 * is empty.
 *
 * Uploads run sequentially: the upstream `@0gfoundation/0g-ts-sdk` uses
 * ethers with auto-managed nonces; concurrent writes from the same wallet
 * race on nonce reservation. Correctness over speed; the batched `update()`
 * at the end keeps on-chain cost bounded.
 */
export async function syncMemory(opts: SyncMemoryOpts): Promise<SyncMemoryResult> {
  if (opts.targets.length === 0) {
    return { updates: [], txHash: null, uploads: [] }
  }
  const key = deriveMemoryKey(opts.agentPrivkey)
  const uploads: SyncMemoryResult['uploads'] = []
  const updates: UpdateSlot[] = []

  for (const target of opts.targets) {
    const bytes = await readOrNull(target.path)
    if (!bytes) continue
    const plaintextHash = keccak256(bytes)
    const ciphertext = encryptMemoryBytes(bytes, key)
    const rootHash = await opts.storage.putBlob(ciphertext)
    if (!rootHash.startsWith('0x') || rootHash.length !== 66) {
      throw new Error(
        `0G Storage returned a root hash that doesn't fit bytes32 (${rootHash.length} chars)`,
      )
    }
    uploads.push({ slot: target.slot, rootHash, plaintextHash })
    updates.push({ slot: target.slot, dataHash: rootHash as Hex })
  }

  if (updates.length === 0) {
    return { updates, txHash: null, uploads }
  }
  const txHash = await opts.nft.updateSlots(opts.tokenId, updates)
  return { updates, txHash, uploads }
}
