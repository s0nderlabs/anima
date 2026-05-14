import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  AnimaAgentNFTReader,
  type AnimaNetwork,
  type IntelligentDataEntry,
  type IntelligentDataSlot,
  bootstrapHashFor,
  decodePackBlob,
  decryptMemoryBytes,
  deriveMemoryKey,
  downloadBlobByRoot,
  ensureSyntheticIndexEntries,
  isV2Envelope,
  restoreProfile,
  writeAgentPack,
  writeUserPack,
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
  /**
   * v0.23.0: operator-scoped AES key for the PROFILE slot (32 bytes). When
   * provided, the profile slot is restored via `restoreProfile` (operator-
   * keyed decrypt). When absent, the profile slot is skipped with reason
   * `no-profile-key` — sandbox cold-start case before operator unlock.
   */
  profileKey?: Buffer
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
  profile: agentDir => `${agentDir}/memory/user/profile.md`,
}

export async function restoreMemoryFromChain(opts: RestoreMemoryOpts): Promise<RestoreOutcome[]> {
  const fetchSlots = opts.fetchSlots ?? defaultFetchSlots(opts)
  const downloadBlob = opts.downloadBlob ?? defaultDownloadBlob(opts.network)
  const memoryKey = deriveMemoryKey(opts.agentPrivkey)

  const slots = await fetchSlots().catch(() => [] as IntelligentDataEntry[])

  // Slots are independent (different paths, different rootHashes). Run them
  // in parallel: a chain-degraded indexer typically takes 3-5s per blob, so
  // serial across 4 slots is 12-20s of boot time vs ~5s parallel.
  const tasks = slots.map(async entry =>
    restoreSlot(entry, opts.agentDir, downloadBlob, memoryKey, {
      network: opts.network,
      profileKey: opts.profileKey,
    }),
  )
  const outcomes = (await Promise.all(tasks)).filter((o): o is RestoreOutcome => o !== null)
  // v0.23.0: top up MEMORY.md with synthetic entries for agent/identity,
  // agent/persona, user/profile so the brain can enumerate them via
  // memory.list. Existing agents that pre-date the seedStarterMemoryFiles
  // profile.md template get backfilled the first time this runs after they
  // have those files on disk (mirror copied or restored).
  await ensureSyntheticIndexEntries(`${opts.agentDir}/memory`).catch(() => {
    // Non-fatal: index sync failures shouldn't block boot.
  })
  return outcomes
}

async function restoreSlot(
  entry: IntelligentDataEntry,
  agentDir: string,
  downloadBlob: (rootHash: string) => Promise<Uint8Array | null>,
  memoryKey: Buffer,
  profileCtx: { network: AnimaNetwork; profileKey: Buffer | undefined },
): Promise<RestoreOutcome | null> {
  const target = RESTORE_TARGETS[entry.dataDescription]
  if (!target) return null
  const path = target(agentDir)
  if (entry.dataHash === ZERO_HASH) {
    return { slot: entry.dataDescription, path, status: 'skipped', reason: 'unset' }
  }
  // v0.23.0: the bootstrap-placeholder hash is `keccak256("anima:bootstrap:<slot>")`,
  // assigned at mint when the operator hasn't uploaded a real blob yet. Trying to
  // download it produces an infinite blob-not-found retry loop. Treat it as
  // intentionally-unset, same as ZERO_HASH. The slot becomes "real" the moment
  // the next /sync flushTurn uploads actual content and calls updateSlots.
  if (entry.dataHash === bootstrapHashFor(entry.dataDescription)) {
    return { slot: entry.dataDescription, path, status: 'skipped', reason: 'bootstrap' }
  }
  if (await fileNonEmpty(path)) {
    return { slot: entry.dataDescription, path, status: 'skipped', reason: 'local-wins' }
  }
  // v0.23.0: PROFILE slot is operator-key encrypted, asymmetric to the other
  // slots. Use restoreProfile (operator-keyed decrypt). Without a profileKey
  // (sandbox cold-start before operator unlock), skip with reason
  // `no-profile-key` — the next flushTurn after unlock re-anchors and the
  // following boot will succeed.
  if (entry.dataDescription === 'profile') {
    if (!profileCtx.profileKey) {
      return { slot: 'profile', path, status: 'skipped', reason: 'no-profile-key' }
    }
    let lastReason: string | null = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await restoreProfile({
        network: profileCtx.network,
        rootHash: entry.dataHash as `0x${string}`,
        profileKey: profileCtx.profileKey,
        profilePath: path,
      })
      if (res.status === 'restored') {
        // v0.24.0: profile blob may carry a v2 pack envelope. Detect by reading
        // back what restoreProfile just wrote — if it's a v2 envelope, unpack
        // it to the user partition (writeUserPack handles root + sibling files).
        const written = await tryReadFile(path)
        if (written && isV2Envelope(written)) {
          try {
            const blob = decodePackBlob(written)
            await writeUserPack(`${agentDir}/memory`, blob)
            return {
              slot: 'profile',
              path,
              status: 'restored',
              bytes: written.length,
              reason: `packed:${Object.keys(blob.files).length}`,
            }
          } catch {
            // Fall through to single-file behavior on parse failure.
          }
        }
        return { slot: 'profile', path, status: 'restored', bytes: res.bytes }
      }
      lastReason = res.reason ?? 'unknown'
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2000))
    }
    console.warn(
      `[memory-restore] slot=profile status=failed reason=${lastReason} root=${entry.dataHash.slice(0, 18)}...`,
    )
    return { slot: 'profile', path, status: 'failed', reason: lastReason ?? 'blob-not-found' }
  }
  // v0.22.0: 3-attempt retry with 2s backoff. 0G Storage's getFileLocations
  // can return empty during transient indexer degradation, and the
  // discovered-nodes fallback also returns null when no finalized=true node
  // responds for a hash. A single shot at boot was the silent-failure mode
  // that left enigma's identity/persona slots missing after a reprovision.
  // Cap at 3 because the boot path is on the user's wait time.
  let ciphertext: Uint8Array | null = null
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      ciphertext = await downloadBlob(entry.dataHash)
      if (ciphertext) break
    } catch (err) {
      lastError = err as Error
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2000))
  }
  if (!ciphertext) {
    const reason = lastError ? lastError.message.slice(0, 200) : 'blob-not-found'
    console.warn(
      `[memory-restore] slot=${entry.dataDescription} status=failed reason=${reason} root=${entry.dataHash.slice(0, 18)}...`,
    )
    return { slot: entry.dataDescription, path, status: 'failed', reason }
  }
  try {
    const plaintext = decryptMemoryBytes(ciphertext, memoryKey)
    // v0.24.0: slot 'memory-index' may carry a v2 pack envelope (root MEMORY.md +
    // every agent/*.md except identity/persona). Unpack instead of single-file
    // write. Legacy v1 raw markdown still works (writePack with empty files map).
    if (entry.dataDescription === 'memory-index' && isV2Envelope(plaintext)) {
      const blob = decodePackBlob(plaintext)
      await writeAgentPack(`${agentDir}/memory`, blob)
      const packedCount = Object.keys(blob.files).length
      return {
        slot: 'memory-index',
        path,
        status: 'restored',
        bytes: plaintext.length,
        reason: `packed:${packedCount}`,
      }
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, plaintext)
    return {
      slot: entry.dataDescription,
      path,
      status: 'restored',
      bytes: plaintext.length,
    }
  } catch (e) {
    const reason = (e as Error).message.slice(0, 200)
    // v0.22.0: surface decrypt failures (wrong key, truncated blob) too — they
    // were silently swallowed by events.publish before.
    console.warn(
      `[memory-restore] slot=${entry.dataDescription} status=failed reason=${reason} (decrypt) root=${entry.dataHash.slice(0, 18)}...`,
    )
    return {
      slot: entry.dataDescription,
      path,
      status: 'failed',
      reason,
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

async function tryReadFile(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path))
  } catch {
    return null
  }
}
