import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type SannClient, derivePubkeyHex, subnameNode } from '@s0nderlabs/anima-core'
import { type Address, type Hex, type PublicClient, getAddress } from 'viem'

/**
 * Resolve a recipient identifier (name or raw EOA) to its EOA address +
 * uncompressed secp256k1 pubkey for ECIES encryption.
 *
 * Primary path: `.0g` text records. Anima publishes both `address` and `pubkey`
 * on its subname during init (Phase 7+). Lookup is one SANN resolver call.
 *
 * Raw-EOA input is supported only for diagnostic / debug paths today; pubkey
 * recovery from chain history is not in MVP scope. The resolver emits a clear
 * error directing the operator to use a `.anima.0g` name instead.
 */

export interface ResolvedRecipient {
  eoa: Address
  pubkey: Hex
  source: 'subname-text-record' | 'cache'
  /** The canonical name if input was a name, else null. */
  name: string | null
}

export interface PubkeyResolverOpts {
  /** Read-only viem client for the agent's network. */
  publicClient: PublicClient
  /** Per-agent state dir under which the resolver caches pubkey lookups. */
  agentDir: string
  /** Optional override of cache TTL. Default 24h. */
  cacheTtlMs?: number
  /** Pre-built SannClient (privkey-bound; used purely for reads here). */
  sann: Pick<SannClient, 'readText'>
}

interface CacheRow {
  eoa: Address
  pubkey: Hex
  name: string | null
  ts: number
}

interface CacheFile {
  v: 1
  byKey: Record<string, CacheRow>
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export class PubkeyResolver {
  private readonly publicClient: PublicClient
  private readonly cachePath: string
  private readonly ttlMs: number
  private readonly sann: Pick<SannClient, 'readText'>
  private cache: CacheFile

  constructor(opts: PubkeyResolverOpts) {
    this.publicClient = opts.publicClient
    this.cachePath = join(opts.agentDir, 'comms', 'pubkey-cache.json')
    this.ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS
    this.sann = opts.sann
    this.cache = this.loadCache()
  }

  /**
   * Resolve `to` to (eoa, pubkey). Names like `alice.anima.0g` are looked up
   * via SANN text records; raw EOAs throw with a directive.
   */
  async resolve(to: string): Promise<ResolvedRecipient> {
    const trimmed = to.trim()
    if (trimmed.length === 0) throw new Error('empty recipient')

    if (trimmed.endsWith('.0g')) {
      return await this.resolveByName(trimmed)
    }
    if (trimmed.startsWith('0x') && trimmed.length === 42) {
      throw new Error(
        `recipient ${trimmed} given as raw EOA; resolve via .anima.0g name (pubkey lookup from chain not in MVP)`,
      )
    }
    throw new Error(`unrecognized recipient format: ${trimmed.slice(0, 80)}`)
  }

  private async resolveByName(name: string): Promise<ResolvedRecipient> {
    const cached = this.cache.byKey[name.toLowerCase()]
    if (cached && Date.now() - cached.ts < this.ttlMs) {
      return { ...cached, source: 'cache' }
    }
    // Strip the `.anima.0g` suffix to get the bare label SANN expects.
    if (!name.endsWith('.anima.0g')) {
      throw new Error(`only *.anima.0g names supported in MVP; got ${name}`)
    }
    const label = name.slice(0, -'.anima.0g'.length)
    if (!label) throw new Error(`empty subname label in ${name}`)
    const node = subnameNode(label)
    const [addressText, pubkeyText] = await Promise.all([
      this.sann.readText(node, 'address').catch(() => ''),
      this.sann.readText(node, 'pubkey').catch(() => ''),
    ])
    if (!addressText) {
      throw new Error(`${name}: address text record not set`)
    }
    if (!pubkeyText) {
      throw new Error(
        `${name}: pubkey text record not set; ask them to run \`anima publish-pubkey\``,
      )
    }
    const eoa = getAddress(addressText) as Address
    const pubkey = (pubkeyText.startsWith('0x') ? pubkeyText : `0x${pubkeyText}`) as Hex
    if (pubkey.length !== 2 + 130) {
      throw new Error(`${name}: pubkey text record malformed (length ${pubkey.length})`)
    }
    const row: CacheRow = { eoa, pubkey, name, ts: Date.now() }
    this.cache.byKey[name.toLowerCase()] = row
    this.persist()
    return { ...row, source: 'subname-text-record' }
  }

  /**
   * Drop one cached entry, e.g. after a name transfer event.
   */
  invalidate(nameOrAddr: string): void {
    delete this.cache.byKey[nameOrAddr.toLowerCase()]
    this.persist()
  }

  private loadCache(): CacheFile {
    if (!existsSync(this.cachePath)) return { v: 1, byKey: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8'))
      if (parsed?.v === 1 && parsed.byKey && typeof parsed.byKey === 'object') return parsed
    } catch {}
    return { v: 1, byKey: {} }
  }

  private persist(): void {
    const dir = dirname(this.cachePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2))
  }
}

/**
 * Convenience: ensure the calling agent's own pubkey is published as a `.0g`
 * text record. Idempotent; reads the current value first and skips the
 * `setText` if it already matches the agent's derived pubkey. Used by
 * `anima publish-pubkey` and by listener boot for backfill of pre-Phase-7
 * agents.
 */
export async function ensureOwnPubkeyPublished(opts: {
  privkeyHex: Hex
  subname: string
  sann: SannClient
}): Promise<{ alreadySet: boolean; txHash?: Hex }> {
  const expected = derivePubkeyHex(opts.privkeyHex)
  if (!opts.subname.endsWith('.anima.0g')) {
    throw new Error(`only *.anima.0g supported, got ${opts.subname}`)
  }
  const label = opts.subname.slice(0, -'.anima.0g'.length)
  const node = subnameNode(label)
  const current = await opts.sann.readText(node, 'pubkey').catch(() => '')
  if (current && current.toLowerCase() === expected.toLowerCase()) {
    return { alreadySet: true }
  }
  const txHash = await opts.sann.setText(node, 'pubkey', expected)
  return { alreadySet: false, txHash }
}
