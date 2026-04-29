import EthCrypto from 'eth-crypto'
import { type Hex, bytesToHex, hexToBytes } from 'viem'

/**
 * ECIES encryption + decryption for A2A messages.
 *
 * eth-crypto's ECIES uses secp256k1 + AES-256-CBC + HMAC-SHA256. The wire
 * envelope is `{ iv, ephemPublicKey, ciphertext, mac }`; we serialize to a
 * compact hex blob via `cipher.stringify` so it fits the contract's `bytes`
 * payload field. The recipient's pubkey must be the 64-byte uncompressed
 * (x||y) form WITHOUT the leading `0x04`. Our published pubkeys via `.0g`
 * text records use the standard 65-byte `0x04...` form, so we strip the
 * prefix here at the boundary.
 */

/**
 * Strip a `0x04` (or `04`) prefix from an uncompressed pubkey for eth-crypto.
 * Idempotent: a 64-byte (128 hex char) pubkey passes through unchanged.
 */
function normalizePubkeyForEthCrypto(pubkey: string): string {
  let p = pubkey.toLowerCase()
  if (p.startsWith('0x')) p = p.slice(2)
  if (p.length === 130 && p.startsWith('04')) p = p.slice(2)
  if (p.length !== 128) {
    throw new Error(
      `pubkey must be 64 bytes (128 hex chars) after stripping prefix; got ${p.length}`,
    )
  }
  return p
}

/**
 * Strip `0x` from a privkey hex; eth-crypto wants raw 64 hex chars.
 */
function normalizePrivkey(privkeyHex: Hex | string): string {
  return privkeyHex.startsWith('0x') ? privkeyHex.slice(2) : privkeyHex
}

/**
 * Encrypt `plaintext` to `recipientPubkey` and return a compact hex blob.
 * Output is the eth-crypto stringified envelope, suitable for placing in
 * the contract's `bytes payload` field.
 */
export async function eciesEncryptToHex(
  plaintext: Uint8Array,
  recipientPubkey: string,
): Promise<Hex> {
  const pub = normalizePubkeyForEthCrypto(recipientPubkey)
  // eth-crypto encrypts strings; our plaintext is bytes. Encode as hex string
  // and on decrypt convert back to bytes.
  const encrypted = await EthCrypto.encryptWithPublicKey(pub, bytesToHex(plaintext))
  const compact = EthCrypto.cipher.stringify(encrypted)
  return `0x${compact}` as Hex
}

/**
 * Decrypt a hex envelope produced by `eciesEncryptToHex` using `privkeyHex`.
 * Returns the original plaintext bytes.
 */
export async function eciesDecryptFromHex(
  envelopeHex: Hex,
  privkeyHex: Hex | string,
): Promise<Uint8Array> {
  const priv = normalizePrivkey(privkeyHex)
  const compact = envelopeHex.startsWith('0x') ? envelopeHex.slice(2) : envelopeHex
  const parsed = EthCrypto.cipher.parse(compact)
  const plaintextHex = await EthCrypto.decryptWithPrivateKey(priv, parsed)
  return hexToBytes(plaintextHex as Hex)
}

export const _internal = { normalizePubkeyForEthCrypto, normalizePrivkey }
