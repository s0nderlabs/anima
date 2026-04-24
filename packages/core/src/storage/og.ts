import { Indexer, MemData } from '@0gfoundation/0g-ts-sdk'
import { JsonRpcProvider, Wallet } from 'ethers'
import type { Hex } from 'viem'
import { NETWORK_RPC } from '../config'
import type { AnimaNetwork } from '../config'
import type { Storage } from './types'

const INDEXER_URL: Record<AnimaNetwork, string> = {
  '0g-mainnet': 'https://indexer-storage-turbo.0g.ai',
  '0g-testnet': 'https://indexer-storage-testnet-turbo.0g.ai',
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
export class OGStorage implements Storage {
  private readonly indexer: Indexer
  private readonly signer: Wallet
  private readonly rpcUrl: string
  private readonly streamManifests: Map<string, Map<string, string>> = new Map()
  private readonly logTips: Map<string, string[]> = new Map()

  constructor(opts: OGStorageOpts) {
    this.indexer = new Indexer(INDEXER_URL[opts.network])
    this.rpcUrl = NETWORK_RPC[opts.network]
    this.signer = new Wallet(opts.privkeyHex, new JsonRpcProvider(this.rpcUrl))
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    const memData = new MemData(bytes)
    // biome-ignore lint/suspicious/noExplicitAny: SDK ethers Signer typing mismatch
    const [tx, err] = await this.indexer.upload(memData, this.rpcUrl, this.signer as any)
    if (err) throw err
    const rootHash = (tx as { rootHash: string }).rootHash
    if (!rootHash) throw new Error('0G upload returned no rootHash')
    return rootHash
  }

  async getBlob(cid: string): Promise<Uint8Array | null> {
    try {
      const [blob, err] = await this.indexer.downloadToBlob(cid, false)
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
