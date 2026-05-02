import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  AnimaAgentNFTReader,
  type AnimaNetwork,
  type IntelligentDataEntry,
  type IntelligentDataSlot,
  decryptMemoryBytes,
  deriveMemoryKey,
  downloadBlobByRoot,
} from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'

/**
 * Phase 11.5 boot-time memory restore.
 *
 * On a fresh container boot the harness sees an empty `${agentDir}/memory/`
 * even though prior sessions anchored MEMORY.md / identity / persona /
 * activity.jsonl on the iNFT updateSlots history. This pulls every anchored
 * slot back to disk before `brain.init` so the brain's frozen prefix sees
 * the agent's actual memory, not a blank slate.
 *
 * Conflict rule: if a non-empty file already exists locally, leave it alone.
 * Local writes that have not flushed to chain yet must NOT be clobbered.
 *
 * Failure rule: per-slot best-effort. One bad blob does not block the boot.
 */
export interface RestoreMemoryOpts {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  agentPrivkey: Hex
  agentDir: string
  /** Override the chain read; tests inject a stub. */
  fetchSlots?: () => Promise<IntelligentDataEntry[]>
  /** Override the storage download; tests inject a stub. */
  downloadBlob?: (rootHash: string) => Promise<Uint8Array | null>
}

export type RestoreStatus = 'restored' | 'skipped' | 'failed'

export interface RestoreOutcome {
  slot: IntelligentDataSlot
  path: string
  status: RestoreStatus
  reason?: string
  bytes?: number
}

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'

/**
 * Slots whose dataHash points at a memory file we should restore on boot.
 * keystore is loaded by the bootstrap path (Option 3 envelope), not here;
 * profile is reserved post-MVP per `defaultMemorySyncTargets` in core/sync.ts.
 */
const RESTORE_TARGETS: Record<IntelligentDataSlot, ((agentDir: string) => string) | null> = {
  'memory-index': agentDir => `${agentDir}/memory/MEMORY.md`,
  identity: agentDir => `${agentDir}/memory/agent/identity.md`,
  persona: agentDir => `${agentDir}/memory/agent/persona.md`,
  'activity-log': agentDir => `${agentDir}/activity.jsonl`,
  keystore: null,
  profile: null,
}

export async function restoreMemoryFromChain(opts: RestoreMemoryOpts): Promise<RestoreOutcome[]> {
  const fetchSlots = opts.fetchSlots ?? defaultFetchSlots(opts)
  const downloadBlob = opts.downloadBlob ?? defaultDownloadBlob(opts.network)
  const memoryKey = deriveMemoryKey(opts.agentPrivkey)

  const slots = await fetchSlots().catch(() => [] as IntelligentDataEntry[])

  // Slots are independent (different paths, different rootHashes). Run them
  // in parallel: a chain-degraded indexer typically takes 3-5s per blob, so
  // serial across 4 slots is 12-20s of boot time vs ~5s parallel.
  const tasks = slots.map(async entry => restoreSlot(entry, opts.agentDir, downloadBlob, memoryKey))
  return (await Promise.all(tasks)).filter((o): o is RestoreOutcome => o !== null)
}

async function restoreSlot(
  entry: IntelligentDataEntry,
  agentDir: string,
  downloadBlob: (rootHash: string) => Promise<Uint8Array | null>,
  memoryKey: Buffer,
): Promise<RestoreOutcome | null> {
  const target = RESTORE_TARGETS[entry.dataDescription]
  if (!target) return null
  const path = target(agentDir)
  if (entry.dataHash === ZERO_HASH) {
    return { slot: entry.dataDescription, path, status: 'skipped', reason: 'unset' }
  }
  if (await fileNonEmpty(path)) {
    return { slot: entry.dataDescription, path, status: 'skipped', reason: 'local-wins' }
  }
  try {
    const ciphertext = await downloadBlob(entry.dataHash)
    if (!ciphertext) {
      return { slot: entry.dataDescription, path, status: 'failed', reason: 'blob-not-found' }
    }
    const plaintext = decryptMemoryBytes(ciphertext, memoryKey)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, plaintext)
    return {
      slot: entry.dataDescription,
      path,
      status: 'restored',
      bytes: plaintext.length,
    }
  } catch (e) {
    return {
      slot: entry.dataDescription,
      path,
      status: 'failed',
      reason: (e as Error).message.slice(0, 200),
    }
  }
}

function defaultFetchSlots(opts: RestoreMemoryOpts): () => Promise<IntelligentDataEntry[]> {
  return async () => {
    const reader = new AnimaAgentNFTReader({
      network: opts.network,
      contractAddress: opts.contractAddress,
    })
    return reader.getIntelligentData(opts.tokenId)
  }
}

function defaultDownloadBlob(
  network: AnimaNetwork,
): (rootHash: string) => Promise<Uint8Array | null> {
  return async (rootHash: string) => downloadBlobByRoot(network, rootHash)
}

async function fileNonEmpty(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isFile() && s.size > 0
  } catch {
    return false
  }
}
