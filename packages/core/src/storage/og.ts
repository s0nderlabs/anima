import { Indexer, MemData, StorageNode, Uploader, getFlowContract } from '@0gfoundation/0g-ts-sdk'
import { JsonRpcProvider, Wallet } from 'ethers'
import type { Hex } from 'viem'
import { MIN_GAS_PRICE, STORAGE_SUBMIT_GAS } from '../chain'
import { NETWORK_RPC } from '../config'
import type { AnimaNetwork } from '../config'
import type { Storage } from './types'

export const INDEXER_URL: Record<AnimaNetwork, string> = {
  '0g-mainnet': 'https://indexer-storage-turbo.0g.ai',
  '0g-testnet': 'https://indexer-storage-testnet-turbo.0g.ai',
}

/**
 * Download a blob from 0G Storage by its merkle root hash.
 * Read-only: does NOT require a signer or funds. Used by `anima restore` to
 * recover an encrypted keystore from storage without needing a local key.
 *
 * Two-step fallback: try the SDK indexer first (which uses the indexer's
 * `trusted` node set); if that comes back empty (mainnet's indexer has been
 * returning `trusted: null` since Apr 2026), walk the discovered-nodes RPC
 * directly. Anyone holding the root hash can fetch their data even when the
 * indexer is degraded.
 */
/**
 * Per-fetch timeouts protect anima boot (harness restoreMemoryFromChain)
 * from a hung 0G Storage indexer or wedged storage node. Without these, a
 * single stuck TCP connection blocks `Ready` indefinitely. Tuned for the
 * indexer-degraded path where probes parallelize but segments serial-walk.
 */
const SDK_INDEXER_TIMEOUT_MS = 30_000
const NODE_LIST_TIMEOUT_MS = 10_000
const NODE_PROBE_TIMEOUT_MS = 5_000
const SEGMENT_DOWNLOAD_TIMEOUT_MS = 30_000

export async function downloadBlobByRoot(
  network: AnimaNetwork,
  rootHash: string,
): Promise<Uint8Array | null> {
  const indexer = new Indexer(INDEXER_URL[network])
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Race the SDK call (which has opaque internal timeouts) against a
    // wall-clock deadline so a wedged indexer can't pin boot. The finally
    // clears the timer on the success path so we don't leak a 30s pending
    // timeout per successful download.
    const sdkRes = await Promise.race([
      indexer.downloadToBlob(rootHash, { proof: false }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('indexer-sdk-timeout')), SDK_INDEXER_TIMEOUT_MS)
      }),
    ])
    const [blob, err] = sdkRes as Awaited<ReturnType<typeof indexer.downloadToBlob>>
    if (!err && blob) return new Uint8Array(await blob.arrayBuffer())
  } catch {
    // Fall through to discovered-nodes path.
  } finally {
    if (timer) clearTimeout(timer)
  }
  return await downloadBlobViaDiscoveredNodes(INDEXER_URL[network], rootHash)
}

/**
 * Discovered-nodes download path: list nodes via `indexer_getShardedNodes`,
 * filter to ones reporting `finalized=true` for this rootHash via
 * `zgs_getFileInfo`, then fetch all chunks via `zgs_downloadSegmentByTxSeq`
 * and concat. Each storage node serves ~256-byte chunks; max ~388 chunks per
 * call, so for blobs <100KB one call suffices.
 *
 * Walks every finalized candidate; first one that returns a usable segment
 * wins. Some nodes report finalized but stutter on the segment fetch.
 */
export async function downloadBlobViaDiscoveredNodes(
  indexerUrl: string,
  rootHash: string,
): Promise<Uint8Array | null> {
  const nodesResp = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'indexer_getShardedNodes',
      params: [],
      id: 1,
    }),
    signal: AbortSignal.timeout(NODE_LIST_TIMEOUT_MS),
  }).catch(() => null)
  if (!nodesResp || !nodesResp.ok) return null
  const idx = (await nodesResp.json().catch(() => null)) as {
    result?: { discovered?: Array<{ url: string }> | null }
  } | null
  const nodes = idx?.result?.discovered ?? []
  if (nodes.length === 0) return null

  type FileInfo = { tx?: { seq: number; size: number }; finalized?: boolean }
  type Candidate = { url: string; txSeq: number; size: number }
  const probes = await Promise.allSettled(
    nodes.map(async (n): Promise<Candidate | null> => {
      const r = await fetch(n.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'zgs_getFileInfo',
          params: [rootHash, false],
          id: 1,
        }),
        signal: AbortSignal.timeout(NODE_PROBE_TIMEOUT_MS),
      })
      const j = (await r.json()) as { result?: FileInfo }
      const info = j.result
      if (info?.finalized && info.tx?.seq !== undefined && info.tx.size !== undefined) {
        return { url: n.url, txSeq: info.tx.seq, size: info.tx.size }
      }
      return null
    }),
  )
  const candidates: Candidate[] = probes
    .map(p => (p.status === 'fulfilled' ? p.value : null))
    .filter((c): c is Candidate => c !== null)
  if (candidates.length === 0) return null

  const CHUNK_BYTES = 256
  for (const cand of candidates) {
    try {
      const chunkCount = Math.ceil(cand.size / CHUNK_BYTES)
      const r = await fetch(cand.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'zgs_downloadSegmentByTxSeq',
          params: [cand.txSeq, 0, chunkCount],
          id: 1,
        }),
        signal: AbortSignal.timeout(SEGMENT_DOWNLOAD_TIMEOUT_MS),
      })
      const dl = (await r.json()) as { result?: string }
      if (!dl.result) continue
      const padded = Buffer.from(dl.result, 'base64')
      return new Uint8Array(padded.subarray(0, cand.size))
    } catch {
      // Try next candidate.
    }
  }
  return null
}

export interface OGStorageOpts {
  network: AnimaNetwork
  privkeyHex: Hex
}

/**
 * 0G Storage adapter implementing the Storage interface (section 25.2).
 *
 * Plain blob via `Indexer.upload`/`downloadToBlob` for keystore, snapshots,
 * avatars, and (indirectly) every memory file. KV semantics are layered on
 * top of plain blobs plus a per-stream manifest file, because the SDK's
 * Batcher requires a live storage node whose URL isn't publicly documented
 * (activity log = blob sequence + KV manifest pattern).
 *
 * ethers is used here because `@0gfoundation/0g-ts-sdk` demands an ethers
 * Signer; matches the same quarantine pattern as `brain/og-compute.ts`.
 */
interface NodeInfo {
  url: string
  config?: { shardId?: number; numShard?: number }
  latency?: number
}

export class OGStorage implements Storage {
  private readonly indexer: Indexer
  private readonly signer: Wallet
  private readonly rpcUrl: string
  private readonly network: AnimaNetwork
  private readonly streamManifests: Map<string, Map<string, string>> = new Map()
  private readonly logTips: Map<string, string[]> = new Map()

  constructor(opts: OGStorageOpts) {
    this.indexer = new Indexer(INDEXER_URL[opts.network])
    this.rpcUrl = NETWORK_RPC[opts.network]
    this.network = opts.network
    this.signer = new Wallet(opts.privkeyHex, new JsonRpcProvider(this.rpcUrl))
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    const memData = new MemData(bytes)
    // First try the canonical SDK path (uses indexer's `trusted` node set).
    try {
      const [tx, err] = await this.indexer.upload(
        memData,
        this.rpcUrl,
        // biome-ignore lint/suspicious/noExplicitAny: SDK ethers Signer typing mismatch
        this.signer as any,
      )
      if (!err) {
        const root = (tx as { rootHash: string }).rootHash
        if (root) return root
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? ''
      // Anything other than the known "trusted: null" pathology bubbles up.
      if (!/Spread syntax requires|cannot select a subset/i.test(msg)) throw e
    }
    // Fallback: 0G mainnet's indexer has been returning `trusted: null` (Apr 26
    // 2026), which makes the SDK's `selectNodes(trusted)` blow up before any
    // upload happens. Pick from `discovered` instead, same node set the SDK
    // would use, just without the indexer's vouching.
    const root = await this.uploadViaDiscoveredNodes(bytes)
    return root
  }

  private async uploadViaDiscoveredNodes(bytes: Uint8Array): Promise<string> {
    const resp = await fetch(this.indexerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'indexer_getShardedNodes',
        params: [],
        id: 1,
      }),
    })
    if (!resp.ok) throw new Error(`indexer_getShardedNodes HTTP ${resp.status}`)
    const json = (await resp.json()) as {
      result?: { trusted?: NodeInfo[] | null; discovered?: NodeInfo[] | null }
    }
    const trusted = json.result?.trusted ?? []
    const discovered = json.result?.discovered ?? []
    const pool = trusted.length > 0 ? trusted : discovered
    if (pool.length === 0) {
      throw new Error('0G indexer returned no trusted or discovered nodes')
    }
    // Prefer numShard=1 (full replica) and lowest latency for our single-replica
    // upload. Falls back to whatever the indexer reports.
    const ranked = [...pool].sort((a, b) => {
      const aShard = a.config?.numShard ?? 1
      const bShard = b.config?.numShard ?? 1
      if (aShard !== bShard) return aShard - bShard
      return (a.latency ?? 9999) - (b.latency ?? 9999)
    })
    let lastErr: Error | null = null
    for (const node of ranked.slice(0, 5)) {
      try {
        const client = new StorageNode(node.url)
        const status = await client.getStatus()
        if (!status?.networkIdentity?.flowAddress) continue
        const flow = getFlowContract(status.networkIdentity.flowAddress, this.signer)
        const uploader = new Uploader([client], this.rpcUrl, flow)
        const memData = new MemData(bytes)
        const [result, err] = await uploader.splitableUpload(memData, {
          tags: '0x',
          finalityRequired: true,
          taskSize: 1,
          expectedReplica: 1,
          fragmentSize: 4_294_967_296,
          skipTx: false,
          skipIfFinalized: false,
          fee: 0n,
        })
        if (err) {
          lastErr = err
          continue
        }
        const root = result?.rootHashes?.[0]
        if (root) return root
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e))
      }
    }
    // Translate the cryptic SDK error when the agent EOA can't afford gas.
    // ethers reports `estimateGas` reverts as `require(false)` because the node
    // returns no revert reason; in that case we check the wallet balance and
    // surface an actionable message instead of the raw stack.
    const lastMsg = lastErr?.message ?? 'unknown'
    if (
      /execution reverted/i.test(lastMsg) ||
      /require\(false\)/i.test(lastMsg) ||
      /insufficient funds/i.test(lastMsg)
    ) {
      const [bal, feeData] = await Promise.all([
        this.signer.provider!.getBalance(this.signer.address),
        this.signer.provider!.getFeeData(),
      ])
      const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? MIN_GAS_PRICE
      const minNeeded = gasPrice * STORAGE_SUBMIT_GAS
      if (bal < minNeeded) {
        const balG = Number(bal) / 1e18
        const needG = Number(minNeeded) / 1e18
        throw new Error(
          `0G Storage submit failed: agent EOA ${this.signer.address} has only ${balG.toFixed(6)} 0G but needs ~${needG.toFixed(6)} 0G for gas at the current price. Top up the agent: \`anima topup --agent 0.5\`.`,
        )
      }
    }
    throw new Error(
      `0G Storage upload failed against all ${ranked.length} discovered nodes. Last error: ${lastMsg}`,
    )
  }

  private get indexerUrl(): string {
    return INDEXER_URL[this.network]
  }

  async getBlob(cid: string): Promise<Uint8Array | null> {
    try {
      const [blob, err] = await this.indexer.downloadToBlob(cid, { proof: false })
      if (err || !blob) return null
      return new Uint8Array(await blob.arrayBuffer())
    } catch {
      return null
    }
  }

  async putKV(stream: string, key: string, value: Uint8Array): Promise<void> {
    const cid = await this.putBlob(value)
    const manifest = await this.#loadManifest(stream)
    manifest.set(key, cid)
    await this.#persistManifest(stream, manifest)
  }

  async getKV(stream: string, key: string): Promise<Uint8Array | null> {
    const manifest = await this.#loadManifest(stream)
    const cid = manifest.get(key)
    if (!cid) return null
    return await this.getBlob(cid)
  }

  async appendLog(stream: string, entry: Uint8Array): Promise<string> {
    const cid = await this.putBlob(entry)
    const tips = this.logTips.get(stream) ?? []
    tips.push(cid)
    this.logTips.set(stream, tips)
    await this.#persistLogTips(stream, tips)
    return cid
  }

  /** Sync all in-memory manifests to chain. Caller invokes on session end. */
  async flush(): Promise<void> {
    for (const [stream, manifest] of this.streamManifests) {
      await this.#persistManifest(stream, manifest)
    }
    for (const [stream, tips] of this.logTips) {
      await this.#persistLogTips(stream, tips)
    }
  }

  async #loadManifest(stream: string): Promise<Map<string, string>> {
    const cached = this.streamManifests.get(stream)
    if (cached) return cached
    const empty = new Map<string, string>()
    this.streamManifests.set(stream, empty)
    return empty
  }

  async #persistManifest(stream: string, manifest: Map<string, string>): Promise<void> {
    const entries = Object.fromEntries(manifest)
    const bytes = new TextEncoder().encode(JSON.stringify({ stream, entries }))
    await this.putBlob(bytes)
  }

  async #persistLogTips(stream: string, tips: string[]): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify({ stream, tips }))
    await this.putBlob(bytes)
  }
}
