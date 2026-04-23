import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * Simple AES-256-GCM keystore for the agent EOA privkey. Passphrase-derived
 * key via scrypt. Format packs salt || iv || tag || ciphertext in base64.
 */
export interface EncryptedKeystore {
  version: 1
  /** Base64-encoded `salt(16) || iv(12) || tag(16) || ciphertext`. */
  blob: string
}

const KEY_LEN = 32
const SCRYPT_N = 2 ** 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 64 * 1024 * 1024

function derive(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
}

export function encryptKey(privkey: Uint8Array, passphrase: string): EncryptedKeystore {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = derive(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(privkey)), cipher.final()])
  const tag = cipher.getAuthTag()
  const blob = Buffer.concat([salt, iv, tag, ct]).toString('base64')
  return { version: 1, blob }
}

export function decryptKey(keystore: EncryptedKeystore, passphrase: string): Uint8Array {
  if (keystore.version !== 1) throw new Error(`Unsupported keystore version: ${keystore.version}`)
  const buf = Buffer.from(keystore.blob, 'base64')
  const salt = buf.subarray(0, 16)
  const iv = buf.subarray(16, 28)
  const tag = buf.subarray(28, 44)
  const ct = buf.subarray(44)
  const key = derive(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]))
}
