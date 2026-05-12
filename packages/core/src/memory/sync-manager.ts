import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type Address, type Hex, keccak256 } from 'viem'
import type { AnimaNetwork } from '../config'
import { AnimaAgentNFTClient, AnimaAgentNFTReader } from '../identity/contract'
import {
  INTELLIGENT_DATA_SLOTS,
  type IntelligentDataSlot,
  type UpdateSlot,
} from '../identity/intelligent-data'
import { agentPaths } from '../paths'
import { OGStorage } from '../storage/og'
import { syncActivityLog } from './activity-sync'
import { deriveMemoryKey, encryptMemoryBytes } from './encryption'
import { readOrNull } from './fs-util'
import { type SyncTarget, defaultMemorySyncTargets } from './sync'

/**
 * Phase 6.7 per-turn auto-sync orchestrator.
 *
 * Tracks last-known plaintext hash per managed slot so subsequent flushes
 * only re-upload + anchor what actually changed. Activity-log + memory
 * updates ride on a SINGLE batched `updateSlots` tx per flush.
 *
 * Slots tracked: memory-index, identity, persona, activity-log.
 * Out of scope: keystore (Phase 6.6 path), profile (post-MVP agent bio),
 * any /user/* files (encrypted to 0G Storage but never anchored on chain).
 */
export interface MemorySyncManagerOpts {
  network: AnimaNetwork
  agentId: string
  agentPrivkey: Hex
  agentAddress: Address
  contractAddress: Address
  tokenId: bigint
  /**
   * Override the activity-log path. The gateway daemon writes its live
   * activity log under `${TMPDIR}/anima-gateway/<id>/activity.jsonl`, not
   * the legacy `~/.anima/agents/<id>/activity.jsonl`. Without this override
   * /sync would upload the stale legacy file (often megabytes of dead data)
   * and ignore the fresh runtime log. Pass whenever the daemon's agentDir
   * differs from `agentPaths.agent(id).dir`.
   */
  activityLogPath?: string
  /**
   * Override the memory directory base. Same rationale as `activityLogPath`:
   * defaults to `~/.anima/agents/<id>/memory/`, but the daemon writes to
   * `${TMPDIR}/anima-gateway/<id>/memory/`. Pass the daemon's memoryDir
   * here so /sync uploads the live MEMORY.md + agent/identity.md +
   * agent/persona.md, not the legacy on-disk copies.
   */
  memoryDir?: string
  /**
   * Path to the sync-state sidecar file. Stores `{slot: plaintextHash}` map
   * of the LAST SUCCESSFUL upload per slot. Read on init() to seed the
   * diff cache so a daemon restart doesn't re-upload everything on the
   * next /sync. Default `${agentDir}/sync-state.json` derived from the
   * activityLogPath's parent dir (or the legacy agentPaths fallback).
   */
  syncStatePath?: string
}

export interface FlushResult {
  /** Slots that uploaded fresh blobs this flush. */
  changedSlots: IntelligentDataSlot[]
  /** Single batched updateSlots tx (or null if nothing changed). */
  txHash: Hex | null
  /** Map slot → {rootHash, plaintextHash} for everything uploaded this flush. */
  uploads: Record<string, { rootHash: Hex; plaintextHash: Hex }>
}

export class MemorySyncManager {
  private readonly storage: OGStorage
  private readonly nft: AnimaAgentNFTClient
  private readonly memoryKey: Buffer
  private readonly fileTargets: SyncTarget[]
  private readonly activityLogPath: string
  private readonly syncStatePath: string
  private lastPlaintextHash: Map<IntelligentDataSlot, Hex> = new Map()
  private inFlight: Promise<FlushResult> | null = null

  constructor(private readonly opts: MemorySyncManagerOpts) {
    this.storage = new OGStorage({ network: opts.network, privkeyHex: opts.agentPrivkey })
    this.nft = new AnimaAgentNFTClient({
      network: opts.network,
      contractAddress: opts.contractAddress,
      privkeyHex: opts.agentPrivkey,
    })
    this.memoryKey = deriveMemoryKey(opts.agentPrivkey)
    this.fileTargets = defaultMemorySyncTargets(opts.agentId, opts.memoryDir)
    this.activityLogPath = opts.activityLogPath ?? agentPaths.agent(opts.agentId).activityLog
    // Sidecar lives alongside activity.jsonl by default so it tracks the
    // same agent state tree (TMPDIR for the gateway daemon, ~/.anima for
    // embedded callers). Falls back to the legacy agent dir if neither
    // override is supplied.
    this.syncStatePath =
      opts.syncStatePath ??
      (opts.activityLogPath
        ? `${dirname(opts.activityLogPath)}/sync-state.json`
        : `${agentPaths.agent(opts.agentId).dir}/sync-state.json`)
  }

  /**
   * Cold start: hydrate the plaintext-hash diff cache from the on-disk
   * sidecar (correct, populated by each successful upload). Fall back to
   * the chain's ciphertext root hashes if the sidecar is missing, but
   * those are only useful for the activity-log slot since the file slots
   * always compare plaintext-vs-stored — first flush after a sidecar-less
   * start will re-upload memory files once, then steady-state diffing
   * keeps things idle.
   *
   * Without the sidecar, every restart caused /sync to upload every slot
   * again (potentially many MB), which on Galileo-sandbox networks could
   * exceed the 15-minute client timeout. The sidecar makes /sync no-op
   * fast when nothing has actually changed.
   */
  async init(): Promise<void> {
    // 1. Sidecar (preferred — plaintext hashes match what doFlush compares).
    try {
      const text = await readFile(this.syncStatePath, 'utf8')
      const parsed = JSON.parse(text) as Record<string, Hex>
      const known = new Set<string>(INTELLIGENT_DATA_SLOTS)
      for (const [slot, hash] of Object.entries(parsed)) {
        if (!known.has(slot)) continue
        if (typeof hash !== 'string' || !hash.startsWith('0x')) continue
        this.lastPlaintextHash.set(slot as IntelligentDataSlot, hash as Hex)
      }
    } catch {
      // Missing or unreadable sidecar — fall through to chain hashes below.
      // First flush will rebuild + persist a sidecar.
    }

    // 2. Chain hashes (only useful when sidecar absent, these are CIPHERTEXT
    // root hashes which don't match plaintext-hash comparisons in doFlush,
    // but they do help the activity-log path skip re-upload when the local
    // file's plaintext hash happens to match what the chain last saw, rare,
    // but the existing on-chain lookup costs us nothing).
    // Skip the RPC round-trip when sidecar already populated every known slot.
    if (this.lastPlaintextHash.size >= INTELLIGENT_DATA_SLOTS.length) return
    try {
      const reader = new AnimaAgentNFTReader({
        network: this.opts.network,
        contractAddress: this.opts.contractAddress,
      })
      const data = await reader.getIntelligentData(this.opts.tokenId)
      const known = new Set<string>(INTELLIGENT_DATA_SLOTS)
      for (const entry of data) {
        if (!known.has(entry.dataDescription)) continue
        if (this.lastPlaintextHash.has(entry.dataDescription as IntelligentDataSlot)) continue
        this.lastPlaintextHash.set(
          entry.dataDescription as IntelligentDataSlot,
          entry.dataHash as Hex,
        )
      }
    } catch {
      // Chain read failed (RPC blip, fresh agent without on-chain history),
      // safe to proceed; first flush handles cold start.
    }
  }

  /** Persist the current plaintext-hash cache to the sidecar. Best-effort. */
  private async writeSidecar(): Promise<void> {
    try {
      const out: Record<string, string> = {}
      for (const [slot, hash] of this.lastPlaintextHash.entries()) {
        out[slot] = hash
      }
      await mkdir(dirname(this.syncStatePath), { recursive: true })
      await writeFile(this.syncStatePath, JSON.stringify(out, null, 2))
    } catch {
      // Non-fatal: a missed sidecar write just means the next /sync may
      // re-upload unchanged slots once. Surface to chain anchor + retry
      // next flush.
    }
  }

  /**
   * Diff local memory + activity-log against last-synced state, upload anything
   * changed, fire one batched chain tx. Back-to-back calls are SERIALIZED
   * via a tail-promise queue: turn N+1's flush starts only after turn N's
   * finishes, so each flush sees its own writes (rather than coalescing
   * onto the in-flight promise and missing them).
   */
  async flushTurn(): Promise<FlushResult> {
    const next = (this.inFlight ?? Promise.resolve(null as unknown as FlushResult))
      .catch(() => null as unknown as FlushResult)
      .then(() => this.doFlush())
    this.inFlight = next.finally(() => {
      if (this.inFlight === next) this.inFlight = null
    })
    return next
  }

  /**
   * Diff-driven flush triggered by `/sync` and pre-transfer. Old versions
   * called `clear()` here, which forced re-upload of EVERY slot even when
   * nothing changed (slow + wasteful + caused the Galileo-sandbox
   * 15-minute timeout because activity-log + memory files all re-encrypted
   * + uploaded together). The sidecar persistence in init() now keeps the
   * cache valid across daemon restarts, so the regular diff in doFlush()
   * is the right ceiling: only uploads slots whose plaintext hash differs
   * from the last successful anchor.
   */
  async flushAll(): Promise<FlushResult> {
    return this.flushTurn()
  }

  private async doFlush(): Promise<FlushResult> {
    const updates: UpdateSlot[] = []
    const uploads: FlushResult['uploads'] = {}
    const changedSlots: IntelligentDataSlot[] = []

    for (const target of this.fileTargets) {
      const bytes = await readOrNull(target.path)
      if (!bytes) continue
      const plaintextHash = keccak256(bytes)
      if (this.lastPlaintextHash.get(target.slot) === plaintextHash) continue

      const ciphertext = encryptMemoryBytes(bytes, this.memoryKey)
      const rootHash = (await this.storage.putBlob(ciphertext)) as Hex
      if (!rootHash.startsWith('0x') || rootHash.length !== 66) {
        throw new Error(
          `0G Storage returned a root hash that doesn't fit bytes32 (${rootHash.length} chars)`,
        )
      }
      uploads[target.slot] = { rootHash, plaintextHash }
      this.lastPlaintextHash.set(target.slot, plaintextHash)
      changedSlots.push(target.slot)
      updates.push({ slot: target.slot, dataHash: rootHash })
    }

    const activityRes = await syncActivityLog({
      activityLogPath: this.activityLogPath,
      memoryKey: this.memoryKey,
      storage: this.storage,
      lastPlaintextHash: this.lastPlaintextHash.get('activity-log') ?? null,
    })
    if (activityRes.uploaded && activityRes.rootHash && activityRes.plaintextHash) {
      uploads['activity-log'] = {
        rootHash: activityRes.rootHash,
        plaintextHash: activityRes.plaintextHash,
      }
      this.lastPlaintextHash.set('activity-log', activityRes.plaintextHash)
      changedSlots.push('activity-log')
      updates.push({ slot: 'activity-log', dataHash: activityRes.rootHash })
    }

    let txHash: Hex | null = null
    if (updates.length > 0) {
      txHash = await this.nft.updateSlots(this.opts.tokenId, updates)
      // Persist sidecar AFTER the chain anchor lands — guarantees the
      // sidecar only reflects state that's actually on chain. If the
      // tx reverts or RPC drops, sidecar stays at the prior state and
      // the next flush retries the same upload (idempotent in 0G
      // Storage: same plaintext → same ciphertext → same root hash).
      await this.writeSidecar()
    }
    return { changedSlots, txHash, uploads }
  }
}
