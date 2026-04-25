import { readFile } from 'node:fs/promises'
import { type Hex, keccak256 } from 'viem'
import type { OGStorage } from '../storage/og'
import { encryptMemoryBytes } from './encryption'

/**
 * Phase 6.7 activity-log sync.
 *
 * Each turn the chat appends events to a local `activity.jsonl`. Per-turn
 * sync uploads a fresh encrypted snapshot of the whole jsonl to 0G Storage
 * and anchors its root hash in the iNFT activity-log slot. Trade-off: blob
 * grows over time. For MVP this is fine; the `chained-blob` optimization
 * (per-turn delta blobs linked via `prev_root`) lands when sessions get long
 * enough that re-uploading the whole jsonl per turn becomes a real cost.
 *
 * Skip when the file's plaintext hash matches `lastPlaintextHash` — same
 * idempotency guarantee the memory-file sync uses.
 */
export interface SyncActivityOpts {
  activityLogPath: string
  /** Memory AES key derived from agent privkey (`deriveMemoryKey`). */
  memoryKey: Buffer
  storage: OGStorage
  /** Last plaintext hash that was anchored, to skip re-upload when nothing changed. */
  lastPlaintextHash?: Hex | null
}

export interface SyncActivityResult {
  rootHash: Hex | null
  plaintextHash: Hex | null
  /** True when the file changed and a new blob was uploaded. */
  uploaded: boolean
}

export async function syncActivityLog(opts: SyncActivityOpts): Promise<SyncActivityResult> {
  const bytes = await readOrNull(opts.activityLogPath)
  if (!bytes) {
    return { rootHash: null, plaintextHash: null, uploaded: false }
  }
  const plaintextHash = keccak256(bytes)
  if (opts.lastPlaintextHash && plaintextHash === opts.lastPlaintextHash) {
    return { rootHash: null, plaintextHash, uploaded: false }
  }
  const ciphertext = encryptMemoryBytes(bytes, opts.memoryKey)
  const rootHash = (await opts.storage.putBlob(ciphertext)) as Hex
  if (!rootHash.startsWith('0x') || rootHash.length !== 66) {
    throw new Error(
      `0G Storage returned a root hash that doesn't fit bytes32 (${rootHash.length} chars)`,
    )
  }
  return { rootHash, plaintextHash, uploaded: true }
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
