// CORS proxy for the 0G Storage indexer. Client-side fetchBlobByRootHash
// falls back to /api/blob/<root> when the indexer rejects cross-origin reads.
// Content-addressed: rootHash is a stable identifier, so we cache aggressively.

import type { NextRequest } from 'next/server'

const INDEXER_URL = 'https://indexer-storage-turbo.0g.ai'
const CHUNK_BYTES = 256

export const runtime = 'nodejs'

export async function GET(_req: NextRequest, context: { params: Promise<{ rootHash: string }> }) {
  const { rootHash } = await context.params
  if (!/^0x[0-9a-fA-F]{64}$/.test(rootHash)) {
    return new Response('invalid root hash', { status: 400 })
  }
  try {
    const bytes = await fetchBlobDirect(rootHash)
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600, immutable',
        'X-Anima-Source': 'og-storage',
      },
    })
  } catch (err) {
    return new Response((err as Error).message || 'blob fetch failed', { status: 502 })
  }
}

type NodeInfo = { url: string }
type FileInfo = { tx?: { seq: number; size: number }; finalized?: boolean }
type Candidate = { url: string; txSeq: number; size: number }

async function fetchBlobDirect(rootHash: string): Promise<Uint8Array> {
  const nodes = await listShardedNodes()
  if (nodes.length === 0) throw new Error('no storage nodes discovered')
  const candidates = await probeFinalizedNodes(nodes, rootHash)
  if (candidates.length === 0) throw new Error('blob not finalized')
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

async function listShardedNodes(): Promise<NodeInfo[]> {
  const resp = await fetch(INDEXER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'indexer_getShardedNodes',
      params: [],
      id: 1,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) throw new Error(`indexer ${resp.status}`)
  const j = (await resp.json()) as {
    result?: { discovered?: NodeInfo[] | null; trusted?: NodeInfo[] | null }
  }
  return [...(j.result?.trusted ?? []), ...(j.result?.discovered ?? [])]
}

async function probeFinalizedNodes(nodes: NodeInfo[], rootHash: string): Promise<Candidate[]> {
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
        signal: AbortSignal.timeout(5_000),
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
    signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) return null
  const dl = (await r.json()) as { result?: string }
  if (!dl.result) return null
  return Uint8Array.from(Buffer.from(dl.result, 'base64')).subarray(0, cand.size)
}
