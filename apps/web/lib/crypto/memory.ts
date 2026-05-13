// Memory blob decryption.
// Mirrors packages/core/src/memory/encryption.ts.

import { type Hex, hexToBytes } from 'viem'
import { aesGcmDecrypt } from './aes-gcm'
import { hkdfSha256, importAesGcmKey } from './hkdf'

const MEMORY_INFO = new TextEncoder().encode('anima-memory-aead-v1')
const EMPTY_SALT = new Uint8Array(0)
const MEMORY_VERSION = 0x01
const MEMORY_VERSION_GZIP = 0x02

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * Derive the AES-256-GCM memory key from the agent's 32-byte private key.
 *
 * Steps (must match encryption.ts:24-34):
 *  1. HKDF-SHA256(ikm=privkey_bytes, salt=empty, info='anima-memory-aead-v1', len=32)
 *  2. Import 32 bytes as AES-GCM CryptoKey
 */
export async function deriveMemoryKey(agentPrivkey: Hex): Promise<CryptoKey> {
  const ikm = hexToBytes(agentPrivkey)
  if (ikm.length !== 32) {
    throw new Error(`expected 32-byte agent privkey, got ${ikm.length}`)
  }
  const rawKey = await hkdfSha256(ikm, EMPTY_SALT, MEMORY_INFO, 32)
  return importAesGcmKey(rawKey)
}

/**
 * Decrypt a memory blob.
 *
 * Blob format (encryption.ts):
 *   version(1) || iv(12) || tag(16) || ciphertext
 *   v=0x01: plaintext encrypted directly.
 *   v=0x02: plaintext gzip-compressed first, then encrypted (activity-log slot
 *           since v0.21.14, 4-5x smaller on the wire).
 */
export async function decryptMemoryBlob(rawBytes: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  if (rawBytes.length < 29) {
    throw new Error(`memory blob too short: ${rawBytes.length} bytes`)
  }
  const version = rawBytes[0]
  if (version !== MEMORY_VERSION && version !== MEMORY_VERSION_GZIP) {
    throw new Error(`unsupported memory blob version 0x${version?.toString(16) ?? '??'}`)
  }
  const iv = rawBytes.slice(1, 13)
  const tag = rawBytes.slice(13, 29)
  const ciphertext = rawBytes.slice(29)
  let decrypted: Uint8Array
  try {
    decrypted = await aesGcmDecrypt(key, iv, ciphertext, tag)
  } catch {
    throw new Error('memory blob decrypt failed, wrong memory key or corrupted blob')
  }
  if (version === MEMORY_VERSION_GZIP) {
    try {
      return await gunzip(decrypted)
    } catch {
      throw new Error('memory blob gunzip failed, corrupted gzip payload')
    }
  }
  return decrypted
}

export function decryptMemoryToText(rawBytes: Uint8Array, key: CryptoKey): Promise<string> {
  return decryptMemoryBlob(rawBytes, key).then(bytes => new TextDecoder().decode(bytes))
}
