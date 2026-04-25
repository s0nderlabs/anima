import { readFile } from 'node:fs/promises'
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
    this.fileTargets = defaultMemorySyncTargets(opts.agentId)
    this.activityLogPath = agentPaths.agent(opts.agentId).activityLog
  }

  /**
   * Optional cold start: read current on-chain slot hashes so the first
   * `flushTurn()` doesn't re-anchor unchanged slots. Skipping `init()` is
   * safe — first flush will just re-upload and produce one redundant tx,
   * then steady-state diffing kicks in. Stored hashes are CIPHERTEXT root
   * hashes (what's on chain), not plaintext hashes — so they only help
   * shortcut the activity-log path on first call. Memory-file slots always
   * recompute via plaintext-hash diff, which is the load-bearing optimization.
   */
  async init(): Promise<void> {
    const reader = new AnimaAgentNFTReader({
      network: this.opts.network,
      contractAddress: this.opts.contractAddress,
    })
    const data = await reader.getIntelligentData(this.opts.tokenId)
    const known = new Set<string>(INTELLIGENT_DATA_SLOTS)
    for (const entry of data) {
      // Defensive: chain returns whatever was written; ignore unknown slot
      // names so a future contract emitting extra entries can't pollute the
      // diff cache.
      if (!known.has(entry.dataDescription)) continue
      this.lastPlaintextHash.set(
        entry.dataDescription as IntelligentDataSlot,
        entry.dataHash as Hex,
      )
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

  /** Force flush regardless of diff state. Used by `anima sync` and pre-transfer. */
  async flushAll(): Promise<FlushResult> {
    this.lastPlaintextHash.clear()
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
    }
    return { changedSlots, txHash, uploads }
  }
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
