// v0.24.0 pack-blob envelope helpers.
// Mirrors packages/core/src/memory/pack-blob.ts — slots 0 (memory-index) and
// 3 (profile) carry a versioned JSON envelope that bundles the root file plus
// every sibling .md file in the partition into ONE encrypted blob.

export const PACK_BLOB_VERSION = 2

export type PackBlob = {
  v: 2
  root: string
  files: Record<string, string>
}

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}\.md$/

/**
 * Cheap byte sniff: is this plaintext a v2 envelope? Tolerates leading
 * whitespace and skips JSON.parse cost for legacy v1 raw markdown.
 */
export function isV2Envelope(plaintext: string): boolean {
  if (plaintext.length === 0) return false
  let i = 0
  while (i < plaintext.length && /\s/.test(plaintext[i] ?? '')) i++
  if (plaintext[i] !== '{') return false
  // Look for `"v":2` in the first 64 chars after the opening brace.
  const head = plaintext.slice(i, Math.min(i + 64, plaintext.length))
  return /"v"\s*:\s*2/.test(head)
}

/**
 * Decode a v2 envelope. Throws if the JSON is malformed OR v !== 2. Drops
 * unsafe filenames (path traversal, uppercase, no .md extension) silently
 * — the core encoder rejects them but a malformed remote blob shouldn't crash
 * the renderer.
 */
export function decodePackBlob(plaintext: string): PackBlob {
  const parsed: unknown = JSON.parse(plaintext)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('pack-blob: not an object')
  }
  const obj = parsed as { v?: unknown; root?: unknown; files?: unknown }
  if (obj.v !== PACK_BLOB_VERSION) {
    throw new Error(`pack-blob: expected v=2, got v=${String(obj.v)}`)
  }
  const root = typeof obj.root === 'string' ? obj.root : ''
  const filesIn =
    typeof obj.files === 'object' && obj.files !== null
      ? (obj.files as Record<string, unknown>)
      : {}
  const files: Record<string, string> = {}
  for (const [name, content] of Object.entries(filesIn)) {
    if (!SAFE_NAME.test(name)) continue
    if (typeof content !== 'string') continue
    files[name] = content
  }
  return { v: 2, root, files }
}

/**
 * Convenience: detect + unpack v2 envelope in one shot. Returns the root
 * file body plus the sibling file map when present, otherwise pass-through
 * for legacy v1 raw markdown. Malformed envelopes also pass through so the
 * operator can still inspect the raw text in source view.
 */
export function unpackIfV2(text: string): {
  body: string
  packedFiles?: Record<string, string>
} {
  if (!isV2Envelope(text)) return { body: text }
  try {
    const blob = decodePackBlob(text)
    return { body: blob.root, packedFiles: blob.files }
  } catch {
    return { body: text }
  }
}
