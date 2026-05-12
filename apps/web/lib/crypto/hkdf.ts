// HKDF-SHA256 via SubtleCrypto. Mirrors Node's `hkdfSync('sha256', ikm, salt, info, len)`
// used in packages/core/src/memory/encryption.ts and operator-keystore-crypto.ts.

export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('SubtleCrypto unavailable — requires HTTPS or localhost')
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    ikm as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: info as BufferSource,
    },
    baseKey,
    lengthBytes * 8,
  )
  return new Uint8Array(bits)
}

export async function importAesGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKey as BufferSource, { name: 'AES-GCM' }, false, [
    'decrypt',
  ])
}
