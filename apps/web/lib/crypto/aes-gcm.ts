// AES-256-GCM decrypt via SubtleCrypto. Mirrors Node `createDecipheriv('aes-256-gcm', key, iv)`
// used in packages/core/src/memory/encryption.ts:46-58 and operator-keystore-crypto.ts:159-174.
//
// Browser convention: the 16-byte GCM auth tag is appended to the ciphertext
// (combined buffer passed as a single arg). Node convention separates them.
// Anima's Node code stores `iv(12) || tag(16) || ciphertext`. We must concatenate
// `ciphertext || tag` before passing to SubtleCrypto.

export async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const combined = new Uint8Array(ciphertext.length + tag.length)
  combined.set(ciphertext, 0)
  combined.set(tag, ciphertext.length)
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: iv as BufferSource,
    tagLength: 128,
  }
  if (additionalData) params.additionalData = additionalData as BufferSource
  const plaintext = await crypto.subtle.decrypt(params, key, combined as BufferSource)
  return new Uint8Array(plaintext)
}
