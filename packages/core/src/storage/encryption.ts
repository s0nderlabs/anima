import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const SCRYPT_N = 1 << 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 64 * 1024 * 1024
const KEY_LEN = 32
const IV_LEN = 12
const TAG_LEN = 16
const SALT_LEN = 16

/**
 * AES-256-GCM symmetric encryption, scrypt-derived key from a passphrase.
 * MVP pattern: each agent has one symmetric key derived from the operator
 * passphrase. Same scrypt parameters as the wallet keystore for consistency.
 *
 * Post-MVP: replace with TEE-sealed key for /agent/ partition + ECIES to
 * operator pubkey for /user/ partition (section 22 wallet architecture).
 */

export interface EncryptedEnvelope {
  /** Random 16-byte salt used to derive the symmetric key. */
  salt: Uint8Array
  /** Random 12-byte GCM IV. */
  iv: Uint8Array
  /** 16-byte GCM auth tag. */
  tag: Uint8Array
  /** Ciphertext. */
  ciphertext: Uint8Array
}

export function encrypt(plaintext: Uint8Array, passphrase: string): EncryptedEnvelope {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    salt,
    iv,
    tag: new Uint8Array(tag),
    ciphertext: new Uint8Array(ciphertext),
  }
}

export function decrypt(envelope: EncryptedEnvelope, passphrase: string): Uint8Array {
  const key = scryptSync(passphrase, envelope.salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.iv)
  decipher.setAuthTag(envelope.tag)
  const plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])
  return new Uint8Array(plaintext)
}

/** Pack envelope into a single byte buffer for storage: salt || iv || tag || ciphertext. */
export function packEnvelope(envelope: EncryptedEnvelope): Uint8Array {
  const total = SALT_LEN + IV_LEN + TAG_LEN + envelope.ciphertext.length
  const out = new Uint8Array(total)
  out.set(envelope.salt, 0)
  out.set(envelope.iv, SALT_LEN)
  out.set(envelope.tag, SALT_LEN + IV_LEN)
  out.set(envelope.ciphertext, SALT_LEN + IV_LEN + TAG_LEN)
  return out
}

/** Unpack a packed envelope back into its fields. */
export function unpackEnvelope(packed: Uint8Array): EncryptedEnvelope {
  if (packed.length < SALT_LEN + IV_LEN + TAG_LEN) {
    throw new Error('envelope shorter than header')
  }
  return {
    salt: packed.slice(0, SALT_LEN),
    iv: packed.slice(SALT_LEN, SALT_LEN + IV_LEN),
    tag: packed.slice(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN),
    ciphertext: packed.slice(SALT_LEN + IV_LEN + TAG_LEN),
  }
}
