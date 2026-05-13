// 0G Storage browser client. Read-only.
// Mirrors packages/core/src/storage/og.ts:downloadBlobViaDiscoveredNodes.
// Pure fetch, no SDK. Lazy CORS detection with fallback to /api/blob/<root>.

import type { Hex } from 'viem'

export const INDEXER_URL_MAINNET = 'https://indexer-storage-turbo.0g.ai'
export const INDEXER_URL_TESTNET = 'https://indexer-storage-testnet-turbo.0g.ai'

const CHUNK_BYTES = 256

type NodeInfo = { url: string }
type FileInfo = { tx?: { seq: number; size: number }; finalized?: boolean }
type Candidate = { url: string; txSeq: number; size: number }

let useProxyMode: boolean | null = null // null = untested, false = direct, true = proxy

function shouldForceProxy(): boolean {
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_INDEXER_PROXY === '1') return true
  return false
}

/**
 * Fetch a blob from 0G Storage by merkle root hash.
 *
 * Tries direct browser → indexer first. On CORS/network failure, retries via
 * the local /api/blob/[rootHash] proxy route. The result of the first attempt
 * is cached for the session so we don't retry the same path repeatedly.
 */
export async function fetchBlobByRootHash(
  rootHash: Hex,
  opts: { indexerUrl?: string; network?: 'mainnet' | 'testnet' } = {},
): Promise<Uint8Array> {
  const indexerUrl =
    opts.indexerUrl || (opts.network === 'testnet' ? INDEXER_URL_TESTNET : INDEXER_URL_MAINNET)

  if (shouldForceProxy()) {
    useProxyMode = true
  }

  if (useProxyMode === null) {
    try {
      const direct = await fetchBlobDirect(indexerUrl, rootHash)
      useProxyMode = false
      return direct
    } catch {
      // Cross-origin probes against individual storage nodes are blocked on
      // prod origins (the nodes don't set Access-Control-Allow-Origin). The
      // /api/blob proxy runs server-side, no CORS. Always fall back; cache
      // the proxy decision for the session.
      useProxyMode = true
    }
  }
  if (useProxyMode) {
    return fetchBlobViaProxy(rootHash)
  }
  try {
    return await fetchBlobDirect(indexerUrl, rootHash)
  } catch {
    return fetchBlobViaProxy(rootHash)
  }
}

async function fetchBlobViaProxy(rootHash: Hex): Promise<Uint8Array> {
  const resp = await fetch(`/api/blob/${rootHash}`)
  if (!resp.ok) {
    throw new Error(`proxy fetch failed: ${resp.status} ${resp.statusText}`)
  }
  const buf = await resp.arrayBuffer()
  return new Uint8Array(buf)
}

async function fetchBlobDirect(indexerUrl: string, rootHash: Hex): Promise<Uint8Array> {
  const nodes = await listShardedNodes(indexerUrl)
  if (nodes.length === 0) throw new Error('no storage nodes discovered')

  const candidates = await probeFinalizedNodes(nodes, rootHash)
  if (candidates.length === 0) throw new Error('blob not finalized on any discovered node')

  for (const cand of candidates) {
    try {
      const bytes = await downloadFromCandidate(cand)
      if (bytes) return bytes
    } catch {
      // try next
    }
  }
  throw new Error('all storage node downloads failed')
}

async function listShardedNodes(indexerUrl: string): Promise<NodeInfo[]> {
  const resp = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'indexer_getShardedNodes',
      params: [],
      id: 1,
    }),
  })
  if (!resp.ok) throw new Error(`indexer ${resp.status}`)
  const j = (await resp.json()) as {
    result?: { discovered?: NodeInfo[] | null; trusted?: NodeInfo[] | null }
  }
  const discovered = j.result?.discovered ?? []
  const trusted = j.result?.trusted ?? []
  // Trusted goes first if non-empty; mainnet returns null as of Apr 2026.
  return [...trusted, ...discovered]
}

async function probeFinalizedNodes(nodes: NodeInfo[], rootHash: Hex): Promise<Candidate[]> {
  const probes = await Promise.allSettled(
    nodes.map(async n => {
      const r = await fetch(n.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'zgs_getFileInfo',
          params: [rootHash, false],
          id: 1,
        }),
      })
      const j = (await r.json()) as { result?: FileInfo }
      const info = j.result
      if (info?.finalized && info.tx?.seq !== undefined && info.tx.size !== undefined) {
        return { url: n.url, txSeq: info.tx.seq, size: info.tx.size }
      }
      return null
    }),
  )
  return probes
    .map(p => (p.status === 'fulfilled' ? p.value : null))
    .filter((c): c is Candidate => c !== null)
}

async function downloadFromCandidate(cand: Candidate): Promise<Uint8Array | null> {
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
  })
  if (!r.ok) return null
  const dl = (await r.json()) as { result?: string }
  if (!dl.result) return null
  const bin = atob(dl.result)
  const padded = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) padded[i] = bin.charCodeAt(i)
  return padded.subarray(0, cand.size)
}
