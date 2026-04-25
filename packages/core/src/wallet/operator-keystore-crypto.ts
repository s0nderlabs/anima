import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { type Address, type Hex, bytesToHex, hexToBytes } from 'viem'
import type { OperatorSigner } from '../operator/signer'

/**
 * Phase 6.6 keystore: agent privkey encrypted with a key derived from the
 * operator's wallet signature. Replaces the v0.5.0 passphrase-based keystore.
 *
 * Why sign-derived-key (not ECIES)? ECIES needs the operator's public key
 * (not just address), and recovering pubkey from a chain-only operator means
 * waiting for them to sign at least once. Sign-derived-key works the same way
 * for every wallet that can sign EIP-712 typed data, which every operator
 * source we support already does (raw privkey via viem, keychain via the
 * raw path, keystore-file via ethers decrypt then viem, WalletConnect via
 * `eth_signTypedData_v4`).
 *
 * Determinism: ECDSA signing under RFC 6979 (deterministic k) gives the same
 * signature for the same `(privkey, message)` every time. viem's
 * `privateKeyToAccount` uses `@noble/secp256k1` which is RFC 6979 by default;
 * MetaMask, Rainbow, Coinbase, Trust, Zerion, Ledger, Trezor all use RFC 6979
 * for EIP-712. So the same operator account always regenerates the same key.
 *
 * Phishing protection: EIP-712 typed data shows the wallet UI a structured
 * "Anima Keystore" message (not an opaque hex blob), so a malicious site can't
 * prompt the operator to sign this thinking it's a login.
 *
 * Format:
 *   raw blob bytes = iv(12) || tag(16) || ciphertext
 *   on-disk JSON   = { version: 2, blob: base64(raw blob bytes) }
 */
export const OPERATOR_KEYSTORE_VERSION = 2 as const

const KS_DOMAIN = { name: 'Anima Keystore', version: '1' } as const
const KS_TYPES = {
  AgentKeystore: [
    { name: 'agent', type: 'address' },
    { name: 'purpose', type: 'string' },
  ],
} as const
const KS_PRIMARY = 'AgentKeystore' as const
const KS_PURPOSE = 'anima-keystore-v1'
const HKDF_INFO = Buffer.from('anima-keystore-aead-v1', 'utf8')

export interface OperatorEncryptedKeystore {
  version: typeof OPERATOR_KEYSTORE_VERSION
  /** Base64 of `iv(12) || tag(16) || ciphertext`. */
  blob: string
}

async function deriveKey(signer: OperatorSigner, agent: Address): Promise<Buffer> {
  const account = await signer.account()
  const sigHex = await account.signTypedData({
    domain: KS_DOMAIN,
    types: KS_TYPES,
    primaryType: KS_PRIMARY,
    message: { agent, purpose: KS_PURPOSE },
  })
  const rs = sigHex.slice(2, 130)
  const ikm = Buffer.from(rs, 'hex')
  if (ikm.length !== 64) {
    throw new Error(
      `Operator signature has unexpected length: ${ikm.length} bytes (expected 64). This source may not produce a 65-byte ECDSA signature; switch operator wallets.`,
    )
  }
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), HKDF_INFO, 32))
}

export async function encryptAgentKey(opts: {
  signer: OperatorSigner
  agentAddress: Address
  agentPrivkey: Hex
}): Promise<OperatorEncryptedKeystore> {
  const key = await deriveKey(opts.signer, opts.agentAddress)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const pt = Buffer.from(hexToBytes(opts.agentPrivkey))
  const ct = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  const blob = Buffer.concat([iv, tag, ct]).toString('base64')
  return { version: OPERATOR_KEYSTORE_VERSION, blob }
}

export async function decryptAgentKey(opts: {
  signer: OperatorSigner
  agentAddress: Address
  keystore: OperatorEncryptedKeystore
}): Promise<Hex> {
  if (opts.keystore.version !== OPERATOR_KEYSTORE_VERSION) {
    throw new Error(
      `Unsupported operator keystore version: ${opts.keystore.version} (expected ${OPERATOR_KEYSTORE_VERSION}). For v1 (passphrase) keystores, run \`anima migrate-keystore\` first.`,
    )
  }
  const buf = Buffer.from(opts.keystore.blob, 'base64')
  if (buf.length < 12 + 16 + 1) {
    throw new Error(`Operator keystore blob too short: ${buf.length} bytes`)
  }
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const key = await deriveKey(opts.signer, opts.agentAddress)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return bytesToHex(new Uint8Array(pt))
}

export function encodeKeystoreBytes(ks: OperatorEncryptedKeystore): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(ks))
}

export function decodeKeystoreBytes(bytes: Uint8Array): OperatorEncryptedKeystore {
  const parsed = JSON.parse(new TextDecoder().decode(bytes))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Keystore bytes do not parse to an object')
  }
  if (parsed.version !== OPERATOR_KEYSTORE_VERSION) {
    throw new Error(
      `Keystore bytes have version ${parsed.version}, expected ${OPERATOR_KEYSTORE_VERSION}`,
    )
  }
  if (typeof parsed.blob !== 'string') {
    throw new Error('Keystore bytes have invalid blob field')
  }
  return parsed as OperatorEncryptedKeystore
}

/**
 * Sniff the keystore version of a serialized blob without doing any crypto.
 * Used by `anima restore` and `anima migrate-keystore` to branch between the
 * v1 (passphrase) and v2 (operator) decrypt paths.
 */
export function sniffKeystoreVersion(bytes: Uint8Array): number | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.version === 'number') {
      return parsed.version
    }
    return null
  } catch {
    return null
  }
}
