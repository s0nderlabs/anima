// Operator-scoped blob decryption.
// Mirrors packages/core/src/wallet/operator-keystore-crypto.ts.
//
// Used for slots encrypted with an operator-derived HKDF key (not the agent
// privkey). Currently the PROFILE slot (anima-profile-v1). On disk these
// blobs are JSON-wrapped:
//   { version: 2, scope: 'anima-profile-v1', blob: base64(iv||tag||ct) }
// Each scope needs its own EIP-712 signature; PROFILE != KEYSTORE.

import { type Hex, hexToBytes } from 'viem'
import { aesGcmDecrypt } from './aes-gcm'
import { hkdfSha256, importAesGcmKey } from './hkdf'

export const OPERATOR_BLOB_VERSION = 2

export const OPERATOR_BLOB_SCOPES = {
  KEYSTORE: 'anima-keystore-v1',
  TELEGRAM: 'anima-telegram-v1',
  PROFILE: 'anima-profile-v1',
} as const

export type OperatorBlobScope =
  (typeof OPERATOR_BLOB_SCOPES)[keyof typeof OPERATOR_BLOB_SCOPES]

export type OperatorBlobEnvelope = {
  version: number
  scope: OperatorBlobScope
  blob: string // base64(iv(12) || tag(16) || ciphertext)
}

export function isOperatorBlobBytes(rawBytes: Uint8Array): boolean {
  if (rawBytes.length === 0) return false
  // JSON envelope always starts with '{' (0x7b). Agent memory blobs start
  // with version byte 0x01 or 0x02 (raw binary). Cheap discriminator.
  return rawBytes[0] === 0x7b
}

export function parseOperatorBlobBytes(rawBytes: Uint8Array): OperatorBlobEnvelope {
  const text = new TextDecoder().decode(rawBytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('operator blob is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('operator blob is not an object')
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.scope !== 'string' || typeof obj.blob !== 'string') {
    throw new Error('operator blob missing scope or blob fields')
  }
  if (typeof obj.version !== 'number') {
    throw new Error('operator blob missing version field')
  }
  return obj as unknown as OperatorBlobEnvelope
}

/**
 * Derive the AES-256-GCM scope key from an EIP-712 operator signature.
 *
 * Steps (must match operator-keystore-crypto.ts:80-103):
 *  1. Take the 65-byte sig
 *  2. Slice r||s (64 bytes, skip v)
 *  3. HKDF-SHA256(ikm=r||s, salt=empty, info=`anima-aead-${scope}`, len=32)
 *  4. Import as AES-GCM CryptoKey
 */
export async function deriveOperatorBlobKey(
  operatorSig: Hex,
  scope: OperatorBlobScope,
): Promise<CryptoKey> {
  if (operatorSig.length !== 132) {
    throw new Error(`expected 65-byte sig (132 hex chars), got ${operatorSig.length}`)
  }
  const rsHex = `0x${operatorSig.slice(2, 130)}` as Hex
  const rsBytes = hexToBytes(rsHex)
  if (rsBytes.length !== 64) {
    throw new Error(`derived r||s should be 64 bytes, got ${rsBytes.length}`)
  }
  const info = new TextEncoder().encode(`anima-aead-${scope}`)
  const rawKey = await hkdfSha256(rsBytes, new Uint8Array(0), info, 32)
  return importAesGcmKey(rawKey)
}

export async function decryptOperatorBlob(
  envelope: OperatorBlobEnvelope,
  key: CryptoKey,
): Promise<Uint8Array> {
  if (envelope.version !== OPERATOR_BLOB_VERSION) {
    throw new Error(
      `unsupported operator blob version ${envelope.version} (expected ${OPERATOR_BLOB_VERSION})`,
    )
  }
  const combined = base64ToBytes(envelope.blob)
  if (combined.length < 12 + 16 + 1) {
    throw new Error(`operator blob inner ciphertext too short: ${combined.length} bytes`)
  }
  const iv = combined.slice(0, 12)
  const tag = combined.slice(12, 28)
  const ciphertext = combined.slice(28)
  try {
    return await aesGcmDecrypt(key, iv, ciphertext, tag)
  } catch {
    throw new Error('operator blob decrypt failed — wrong key or corrupted ciphertext')
  }
}

export async function decryptOperatorBlobToText(
  rawBytes: Uint8Array,
  key: CryptoKey,
): Promise<string> {
  const envelope = parseOperatorBlobBytes(rawBytes)
  const plaintext = await decryptOperatorBlob(envelope, key)
  return new TextDecoder().decode(plaintext)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
