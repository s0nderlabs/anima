// Operator-wallet keystore decryption (Phase 6.6 sign-derived-key).
// Mirrors packages/core/src/wallet/operator-keystore-crypto.ts.

import { type Hex, hexToBytes } from 'viem'
import { aesGcmDecrypt } from './aes-gcm'
import { hkdfSha256, importAesGcmKey } from './hkdf'

const KEYSTORE_INFO = new TextEncoder().encode('anima-keystore-aead-v1')
const EMPTY_SALT = new Uint8Array(0)

export type KeystoreBlob = {
  version: number
  blob: string // base64(iv || tag || ciphertext)
}

/**
 * Derive the AES-256-GCM keystore key from a signed EIP-712 signature.
 *
 * Steps (must match operator-keystore-crypto.ts:79-101):
 *  1. Take the 65-byte signature
 *  2. Slice off `0x` prefix and `v` byte (last byte) → r||s (64 bytes)
 *  3. HKDF-SHA256(ikm=r||s, salt=empty, info='anima-keystore-aead-v1', len=32)
 *  4. Import 32 bytes as AES-GCM CryptoKey
 */
export async function deriveKeystoreKey(operatorSig: Hex): Promise<CryptoKey> {
  // sig is 0x + 130 hex chars = r(64) + s(64) + v(2). We want r||s only.
  if (operatorSig.length !== 132) {
    throw new Error(`expected 65-byte signature (132 hex chars), got ${operatorSig.length}`)
  }
  const rsHex = `0x${operatorSig.slice(2, 130)}` as Hex
  const rsBytes = hexToBytes(rsHex)
  if (rsBytes.length !== 64) {
    throw new Error(`derived r||s should be 64 bytes, got ${rsBytes.length}`)
  }
  const rawKey = await hkdfSha256(rsBytes, EMPTY_SALT, KEYSTORE_INFO, 32)
  return importAesGcmKey(rawKey)
}

/**
 * Decrypt the keystore blob fetched from 0G Storage (slot 4 of the iNFT).
 *
 * Blob format (operator-keystore-crypto.ts:26-30 + :160-162):
 *   JSON { version: 2, blob: base64(iv(12) || tag(16) || ciphertext) }
 *
 * Returns the agent's 32-byte private key as a 0x-prefixed hex string.
 */
export async function decryptKeystoreBlob(rawBytes: Uint8Array, key: CryptoKey): Promise<Hex> {
  const text = new TextDecoder().decode(rawBytes)
  let parsed: KeystoreBlob
  try {
    parsed = JSON.parse(text) as KeystoreBlob
  } catch {
    throw new Error('keystore blob is not valid JSON')
  }
  if (parsed.version !== 2) {
    throw new Error(`unsupported keystore version ${parsed.version} (expected 2)`)
  }
  const combined = base64ToBytes(parsed.blob)
  if (combined.length < 28) {
    throw new Error(`keystore blob too short: ${combined.length} bytes`)
  }
  const iv = combined.slice(0, 12)
  const tag = combined.slice(12, 28)
  const ciphertext = combined.slice(28)

  let plaintext: Uint8Array
  try {
    plaintext = await aesGcmDecrypt(key, iv, ciphertext, tag)
  } catch {
    throw new Error('keystore decrypt failed — wrong operator wallet or corrupted blob')
  }
  if (plaintext.length !== 32) {
    throw new Error(`expected 32-byte agent privkey, got ${plaintext.length}`)
  }
  return bytesToHex(plaintext) as Hex
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '0x'
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
