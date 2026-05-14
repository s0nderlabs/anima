/**
 * v0.24.0: versioned envelope format for the memory-index (slot 0) and
 * profile (slot 3) blobs. The legacy v1 layout stored a single markdown
 * file's raw text. The v2 envelope wraps the root file's content plus
 * an arbitrary map of additional sibling files so the harness can anchor
 * the whole partition with one slot per partition.
 *
 * Why: pre-v0.24.0, only the 6 hard-coded `RESTORE_TARGETS` files survived
 * reprovision. Every other `agent/*.md` and `user/*.md` was local-only
 * scratchpad, and MEMORY.md retained dangling references after a fresh
 * sandbox boot. The iNFT contract caps slots at 6 per token and is
 * immutable, so adding new slots is impossible without re-minting every
 * existing agent. The fix: extend the encoding of slots 0 + 3 without
 * touching the contract.
 *
 * Envelope shape (plaintext, pre-encryption):
 *
 *   { "v": 2,
 *     "root": "<markdown body of the canonical file>",
 *     "files": { "<filename>.md": "<markdown body>", ... } }
 *
 * - For slot 0 (memory-index, agent key): `root` is MEMORY.md text.
 *   `files` keys are paths under `memory/agent/` (e.g. `learned-foo.md`).
 *   `identity.md` and `persona.md` are NOT packed here — they keep their
 *   own slots (1, 2).
 * - For slot 3 (profile, operator PROFILE key): `root` is profile.md text.
 *   `files` keys are paths under `memory/user/` (e.g.
 *   `operator-preferences.md`). `profile.md` itself is NOT a `files` key
 *   (its content is in `root`).
 *
 * Backwards compat:
 *
 * - `isV2Envelope(bytes)`: cheap byte sniff — first non-whitespace char
 *   must be `{` AND the parsed object must have `"v": 2`.
 * - Decoders fall through to legacy v1 (raw markdown) when sniff fails.
 * - Encoders default to v2; pass `legacy: true` for the old single-file
 *   format if a caller specifically needs v1 wire-compat.
 *
 * Filename sanitization:
 *
 * Keys in `files` must match `^[a-z0-9][a-z0-9._-]{0,63}\.md$` to keep
 * the pack format predictable. The brain's slug generator (`toSlug` in
 * `save-tool.ts`) already produces filenames that match. Unsafe names
 * (path traversal, absolute paths, weird chars) are rejected at encode
 * time.
 */

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}\.md$/

export const PACK_BLOB_VERSION = 2 as const

export interface PackBlob {
  v: typeof PACK_BLOB_VERSION
  /** Root file content (MEMORY.md for slot 0, profile.md for slot 3). */
  root: string
  /** Additional packed files keyed by filename. May be empty. */
  files: Record<string, string>
}

export interface EncodePackOpts {
  root: string
  files?: Record<string, string>
}

/** Encode a pack blob to UTF-8 bytes ready for AES-GCM encryption. */
export function encodePackBlob(opts: EncodePackOpts): Uint8Array {
  const files: Record<string, string> = {}
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    if (!SAFE_NAME.test(name)) {
      throw new Error(`pack-blob: unsafe filename ${JSON.stringify(name)}`)
    }
    files[name] = content
  }
  const blob: PackBlob = { v: PACK_BLOB_VERSION, root: opts.root, files }
  return new TextEncoder().encode(JSON.stringify(blob))
}

/**
 * Returns true if `bytes` looks like a v2 envelope (starts with `{` and
 * parses to `{ v: 2 }`). Cheap enough to call on every restore.
 */
export function isV2Envelope(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let i = 0; i < bytes.length && i < 16; i++) {
    const b = bytes[i] as number
    if (b === 0x7b /* { */) break
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue
    return false
  }
  try {
    const text = new TextDecoder().decode(bytes)
    const parsed = JSON.parse(text) as { v?: unknown }
    return parsed && typeof parsed === 'object' && parsed.v === PACK_BLOB_VERSION
  } catch {
    return false
  }
}

/**
 * Decode a v2 envelope. Throws if `bytes` is not a valid v2 envelope.
 * Caller is expected to have run `isV2Envelope` first when handling
 * legacy/v2 mixed input.
 */
export function decodePackBlob(bytes: Uint8Array): PackBlob {
  const text = new TextDecoder().decode(bytes)
  const parsed = JSON.parse(text) as Partial<PackBlob>
  if (parsed.v !== PACK_BLOB_VERSION) {
    throw new Error(`pack-blob: expected v=${PACK_BLOB_VERSION}, got ${parsed.v}`)
  }
  if (typeof parsed.root !== 'string') {
    throw new Error('pack-blob: missing root field')
  }
  const files: Record<string, string> = {}
  for (const [name, content] of Object.entries(parsed.files ?? {})) {
    if (typeof content !== 'string') continue
    if (!SAFE_NAME.test(name)) continue
    files[name] = content
  }
  return { v: PACK_BLOB_VERSION, root: parsed.root, files }
}
