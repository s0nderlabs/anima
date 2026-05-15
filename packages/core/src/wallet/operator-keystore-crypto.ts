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
const HKDF_INFO_KEYSTORE = Buffer.from('anima-keystore-aead-v1', 'utf8')

/**
 * Scope strings used as the EIP-712 `purpose` field. New scopes get their own
 * derived key (different signature, different HKDF output) so a phishing site
 * cannot replay one scope's signature against another. Add new scopes here as
 * Phase 12 / Phase 13 needs them.
 */
export const OPERATOR_BLOB_SCOPES = {
  KEYSTORE: 'anima-keystore-v1',
  TELEGRAM: 'anima-telegram-v1',
  PROFILE: 'anima-profile-v1',
} as const
export type OperatorBlobScope =
  | (typeof OPERATOR_BLOB_SCOPES)[keyof typeof OPERATOR_BLOB_SCOPES]
  | string

export interface OperatorEncryptedKeystore {
  version: typeof OPERATOR_KEYSTORE_VERSION
  /** Base64 of `iv(12) || tag(16) || ciphertext`. */
  blob: string
}

/**
 * Versioned, scoped operator-encrypted blob. Used for non-keystore secrets
 * (e.g. telegram bot token + allowlisted user ids).
 *
 * `scope` is the EIP-712 `purpose` field used to derive the AEAD key, and is
 * persisted on disk so the loader can route to the correct decrypt scope
 * without prompting twice.
 */
export interface OperatorEncryptedBlob {
  version: typeof OPERATOR_KEYSTORE_VERSION
  scope: OperatorBlobScope
  /** Base64 of `iv(12) || tag(16) || ciphertext`. */
  blob: string
}

function hkdfKeyFromSigHex(sigHex: string, info: Buffer): Buffer {
  const rs = sigHex.slice(2, 130)
  const ikm = Buffer.from(rs, 'hex')
  if (ikm.length !== 64) {
    throw new Error(
      `Operator signature has unexpected length: ${ikm.length} bytes (expected 64). This source may not produce a 65-byte ECDSA signature; switch operator wallets.`,
    )
  }
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32))
}

/**
 * v0.24.9: backward-compat fallback used during decrypt when the canonical
 * key fails AES-GCM. Only the pre-v0.24.9 WalletConnect signer exposes
 * `signTypedDataLegacyEmptyDomain` on its Account object (raw-privkey,
 * keystore-file, keychain all go through viem's canonical hashTypedData).
 * Returns null when the signer doesn't expose the legacy method (canonical
 * path was correct, AES-GCM failure means actually-wrong-key).
 *
 * See `feedback-wc-signTypedData-eip712domain-trap.md` for the full root
 * cause: legacy WC shipped typed-data verbatim without `EIP712Domain` in
 * types, so MetaMask's `sanitizeData` inserted `EIP712Domain: []` (empty)
 * and hashed the domain separator over `keccak256("EIP712Domain()")`,
 * diverging from viem's canonical hash over the populated field list.
 */
type LegacyEmptyDomainSigner = {
  signTypedDataLegacyEmptyDomain?: (typedData: unknown) => Promise<`0x${string}`>
}

async function tryDeriveLegacyEmptyDomainKey(
  signer: OperatorSigner,
  agent: Address,
  scope: OperatorBlobScope,
  info: Buffer,
): Promise<Buffer | null> {
  const account = (await signer.account()) as unknown as LegacyEmptyDomainSigner
  const legacy = account.signTypedDataLegacyEmptyDomain
  if (!legacy) return null
  try {
    const sigHex = await legacy({
      domain: KS_DOMAIN,
      types: KS_TYPES,
      primaryType: KS_PRIMARY,
      message: { agent, purpose: scope },
    })
    return hkdfKeyFromSigHex(sigHex, info)
  } catch {
    return null
  }
}

/**
 * v0.24.10: Public wrapper around `tryDeriveLegacyEmptyDomainKey` so the
 * operator-session verify-and-swap path can derive a legacy variant key for
 * any scope without re-implementing the EIP-712 plumbing. Returns null when
 * the signer doesn't expose the legacy escape hatch (every LocalAccount
 * signer) OR the legacy sign call throws.
 */
export async function deriveLegacyEmptyDomainKey(
  signer: OperatorSigner,
  agent: Address,
  scope: 'keystore' | OperatorBlobScope,
): Promise<Buffer | null> {
  const rawScope = scope === 'keystore' ? KS_PURPOSE : scope
  const info = scope === 'keystore' ? HKDF_INFO_KEYSTORE : hkdfInfoForScope(scope)
  return tryDeriveLegacyEmptyDomainKey(signer, agent, rawScope, info)
}

function isAesGcmAuthError(e: unknown): boolean {
  const msg = (e as Error | undefined)?.message ?? ''
  // Node + Bun crypto both surface AES-GCM tag failures as
  // "Unsupported state or unable to authenticate data". Any other
  // crypto error (wrong key length, bad input length) should rethrow
  // so callers see the real cause.
  return msg.includes('Unsupported state or unable to authenticate')
}

function hkdfInfoForScope(scope: OperatorBlobScope): Buffer {
  return Buffer.from(`anima-aead-${scope}`, 'utf8')
}

async function deriveScopedKey(
  signer: OperatorSigner,
  scope: OperatorBlobScope,
  agent: Address,
): Promise<Buffer> {
  const account = await signer.account()
  const sigHex = await account.signTypedData({
    domain: KS_DOMAIN,
    types: KS_TYPES,
    primaryType: KS_PRIMARY,
    message: { agent, purpose: scope },
  })
  return hkdfKeyFromSigHex(sigHex, hkdfInfoForScope(scope))
}

async function deriveKey(signer: OperatorSigner, agent: Address): Promise<Buffer> {
  // Uses HKDF_INFO_KEYSTORE (not the per-scope info) to keep the on-disk
  // format backward-compatible with pre-Phase-12 keystores.
  const account = await signer.account()
  const sigHex = await account.signTypedData({
    domain: KS_DOMAIN,
    types: KS_TYPES,
    primaryType: KS_PRIMARY,
    message: { agent, purpose: KS_PURPOSE },
  })
  return hkdfKeyFromSigHex(sigHex, HKDF_INFO_KEYSTORE)
}

export async function encryptAgentKey(opts: {
  signer?: OperatorSigner
  agentAddress: Address
  agentPrivkey: Hex
  /**
   * v0.23.1: Optional pre-derived AES-256 key (32 bytes). When present, skips
   * `signer.signTypedData` entirely. Used by `anima init` to share the same
   * key derivation between the keystore encryption and the operator-session
   * cache write, so the operator signs once (not twice) for the keystore scope.
   */
  precomputedKey?: Buffer
}): Promise<OperatorEncryptedKeystore> {
  let key: Buffer
  if (opts.precomputedKey) {
    if (opts.precomputedKey.length !== 32) {
      throw new Error(`Precomputed key must be 32 bytes, got ${opts.precomputedKey.length}`)
    }
    key = opts.precomputedKey
  } else {
    if (!opts.signer) {
      throw new Error('encryptAgentKey requires either signer or precomputedKey')
    }
    key = await deriveKey(opts.signer, opts.agentAddress)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const pt = Buffer.from(hexToBytes(opts.agentPrivkey))
  const ct = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  const blob = Buffer.concat([iv, tag, ct]).toString('base64')
  return { version: OPERATOR_KEYSTORE_VERSION, blob }
}

function decryptAesGcmStrict(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/**
 * v0.24.9: try canonical key first; on AES-GCM auth failure, try the
 * legacy empty-EIP712Domain variant for backwards-compat decrypt of
 * pre-v0.24.9 WalletConnect-init'd blobs. Only the legacy-WC Account
 * exposes `signTypedDataLegacyEmptyDomain`, so this fallback is a no-op
 * for LocalAccount signers (raw-privkey, keystore-file, keychain) which
 * always produce the canonical hash. When `precomputedKey` is supplied
 * the fallback is intentionally skipped: callers cache one variant and
 * we trust the cache.
 */
async function decryptAesGcmWithLegacyFallback(opts: {
  canonicalKey: Buffer
  iv: Buffer
  tag: Buffer
  ct: Buffer
  signer?: OperatorSigner
  agentAddress: Address
  scope: OperatorBlobScope
  hkdfInfo: Buffer
  hadPrecomputedKey: boolean
}): Promise<Buffer> {
  try {
    return decryptAesGcmStrict(opts.canonicalKey, opts.iv, opts.tag, opts.ct)
  } catch (canonicalError) {
    if (!isAesGcmAuthError(canonicalError) || opts.hadPrecomputedKey || !opts.signer) {
      throw canonicalError
    }
    const legacyKey = await tryDeriveLegacyEmptyDomainKey(
      opts.signer,
      opts.agentAddress,
      opts.scope,
      opts.hkdfInfo,
    )
    if (!legacyKey) throw canonicalError
    return decryptAesGcmStrict(legacyKey, opts.iv, opts.tag, opts.ct)
  }
}

export async function decryptAgentKey(opts: {
  signer?: OperatorSigner
  agentAddress: Address
  keystore: OperatorEncryptedKeystore
  /**
   * Optional pre-derived AES-256 key (32 bytes). When present, skips
   * `signer.signTypedData` entirely. Used by the headless gateway path: a
   * prior interactive `anima gateway start` derives the key once via the
   * operator signer, persists it in the operator-session file, and the
   * gateway daemon reads it from there at boot. Bypasses Touch ID at every
   * daemon restart while preserving the keystore-derivation security model
   * (key is fully equivalent to what `signer` would produce, just cached).
   */
  precomputedKey?: Buffer
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
  let canonicalKey: Buffer
  if (opts.precomputedKey) {
    if (opts.precomputedKey.length !== 32) {
      throw new Error(`Precomputed key must be 32 bytes, got ${opts.precomputedKey.length}`)
    }
    canonicalKey = opts.precomputedKey
  } else {
    if (!opts.signer) {
      throw new Error('decryptAgentKey requires either signer or precomputedKey')
    }
    canonicalKey = await deriveKey(opts.signer, opts.agentAddress)
  }
  const pt = await decryptAesGcmWithLegacyFallback({
    canonicalKey,
    iv,
    tag,
    ct,
    signer: opts.signer,
    agentAddress: opts.agentAddress,
    scope: KS_PURPOSE,
    hkdfInfo: HKDF_INFO_KEYSTORE,
    hadPrecomputedKey: Boolean(opts.precomputedKey),
  })
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
 * Encrypt an arbitrary operator-owned secret blob with a scope-derived key.
 * Phase 12 uses this to persist `{telegram: {botToken, allowedUserIds}}` to
 * `~/.anima/agents/<id>/telegram-secrets.encrypted`.
 *
 * Each scope (`OPERATOR_BLOB_SCOPES.*`) gets its own EIP-712 sig + HKDF
 * output. A phishing site that obtains one scope's sig cannot decrypt another.
 */
export async function encryptOperatorBlob(opts: {
  signer?: OperatorSigner
  scope: OperatorBlobScope
  agentAddress?: Address
  plaintext: Uint8Array
  /** Pre-derived scope key (32 bytes). When provided, skips signer derivation. */
  precomputedKey?: Buffer
}): Promise<OperatorEncryptedBlob> {
  let key: Buffer
  if (opts.precomputedKey) {
    if (opts.precomputedKey.length !== 32) {
      throw new Error(`Precomputed key must be 32 bytes, got ${opts.precomputedKey.length}`)
    }
    key = opts.precomputedKey
  } else {
    if (!opts.signer || !opts.agentAddress) {
      throw new Error('encryptOperatorBlob requires either signer+agentAddress or precomputedKey')
    }
    key = await deriveScopedKey(opts.signer, opts.scope, opts.agentAddress)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(opts.plaintext)), cipher.final()])
  const tag = cipher.getAuthTag()
  const blob = Buffer.concat([iv, tag, ct]).toString('base64')
  return { version: OPERATOR_KEYSTORE_VERSION, scope: opts.scope, blob }
}

export async function decryptOperatorBlob(opts: {
  signer?: OperatorSigner
  scope: OperatorBlobScope
  agentAddress: Address
  blob: OperatorEncryptedBlob
  /** Pre-derived scope key (32 bytes). Skips signer when present. */
  precomputedKey?: Buffer
}): Promise<Uint8Array> {
  if (opts.blob.version !== OPERATOR_KEYSTORE_VERSION) {
    throw new Error(
      `Unsupported operator blob version: ${opts.blob.version} (expected ${OPERATOR_KEYSTORE_VERSION}).`,
    )
  }
  if (opts.blob.scope !== opts.scope) {
    throw new Error(
      `Operator blob scope mismatch: blob has '${opts.blob.scope}', expected '${opts.scope}'. Refusing to decrypt across scopes.`,
    )
  }
  const buf = Buffer.from(opts.blob.blob, 'base64')
  if (buf.length < 12 + 16 + 1) {
    throw new Error(`Operator blob too short: ${buf.length} bytes`)
  }
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  let canonicalKey: Buffer
  if (opts.precomputedKey) {
    if (opts.precomputedKey.length !== 32) {
      throw new Error(`Precomputed key must be 32 bytes, got ${opts.precomputedKey.length}`)
    }
    canonicalKey = opts.precomputedKey
  } else {
    if (!opts.signer) {
      throw new Error('decryptOperatorBlob requires either signer or precomputedKey')
    }
    canonicalKey = await deriveScopedKey(opts.signer, opts.scope, opts.agentAddress)
  }
  const pt = await decryptAesGcmWithLegacyFallback({
    canonicalKey,
    iv,
    tag,
    ct,
    signer: opts.signer,
    agentAddress: opts.agentAddress,
    scope: opts.scope,
    hkdfInfo: hkdfInfoForScope(opts.scope),
    hadPrecomputedKey: Boolean(opts.precomputedKey),
  })
  return new Uint8Array(pt)
}

/**
 * Derive the legacy keystore AES key for `decryptAgentKey`. Public so the
 * operator-session writer can pre-derive once and cache. Headless gateway
 * boots from the cached key.
 */
export async function deriveKeystoreKey(signer: OperatorSigner, agent: Address): Promise<Buffer> {
  return deriveKey(signer, agent)
}

/**
 * Derive a scope-specific AES key for `decryptOperatorBlob`. Same caching
 * use case as `deriveKeystoreKey`.
 */
export async function deriveBlobKey(
  signer: OperatorSigner,
  agent: Address,
  scope: OperatorBlobScope,
): Promise<Buffer> {
  return deriveScopedKey(signer, scope, agent)
}

export function encodeOperatorBlobBytes(blob: OperatorEncryptedBlob): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(blob))
}

export function decodeOperatorBlobBytes(bytes: Uint8Array): OperatorEncryptedBlob {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Operator blob bytes do not parse to an object')
  }
  if (parsed.version !== OPERATOR_KEYSTORE_VERSION) {
    throw new Error(
      `Operator blob version mismatch: got ${parsed.version}, expected ${OPERATOR_KEYSTORE_VERSION}`,
    )
  }
  if (typeof parsed.scope !== 'string' || typeof parsed.blob !== 'string') {
    throw new Error('Operator blob bytes have invalid scope/blob fields')
  }
  return parsed as unknown as OperatorEncryptedBlob
}

/**
 * v0.24.10: Trial-decrypt a keystore blob with a candidate AES key. Returns
 * true on success, false on AES-GCM auth failure or any malformed-input
 * issue. Used by `precomputeAllScopes`'s verify-and-swap path to detect
 * whether a freshly derived canonical key actually decrypts the on-disk
 * keystore (a wrong key surfaces as an AES-GCM auth failure here, which
 * triggers the legacy fallback).
 */
export function tryDecryptKeystoreWithKey(
  keystore: OperatorEncryptedKeystore,
  key: Buffer,
): boolean {
  if (keystore.version !== OPERATOR_KEYSTORE_VERSION) return false
  if (key.length !== 32) return false
  const buf = Buffer.from(keystore.blob, 'base64')
  if (buf.length < 12 + 16 + 1) return false
  try {
    decryptAesGcmStrict(key, buf.subarray(0, 12), buf.subarray(12, 28), buf.subarray(28))
    return true
  } catch {
    return false
  }
}

/**
 * v0.24.10: Same as `tryDecryptKeystoreWithKey` for a scoped operator blob.
 * Verifies the blob's stored scope matches `expectedScope` before attempting
 * decrypt so a key derived for one scope can't accidentally "verify" against
 * a blob from another scope.
 */
export function tryDecryptOperatorBlobWithKey(
  blob: OperatorEncryptedBlob,
  key: Buffer,
  expectedScope: OperatorBlobScope,
): boolean {
  if (blob.version !== OPERATOR_KEYSTORE_VERSION) return false
  if (blob.scope !== expectedScope) return false
  if (key.length !== 32) return false
  const buf = Buffer.from(blob.blob, 'base64')
  if (buf.length < 12 + 16 + 1) return false
  try {
    decryptAesGcmStrict(key, buf.subarray(0, 12), buf.subarray(12, 28), buf.subarray(28))
    return true
  } catch {
    return false
  }
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
