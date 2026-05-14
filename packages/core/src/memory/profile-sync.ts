import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type Hex, keccak256 } from 'viem'
import type { AnimaNetwork } from '../config'
import { OGStorage, downloadBlobByRoot } from '../storage/og'
import {
  OPERATOR_BLOB_SCOPES,
  decodeOperatorBlobBytes,
  decryptOperatorBlob,
  encodeOperatorBlobBytes,
  encryptOperatorBlob,
} from '../wallet/operator-keystore-crypto'

/**
 * v0.23.0 — profile slot lifecycle (project-anima.md section 26.3 + 27).
 *
 * The PROFILE slot (index 3 in INTELLIGENT_DATA_SLOTS) is the user-partition
 * blob, asymmetric to the other slots:
 *   - slots memory-index / identity / persona / activity-log / keystore are
 *     encrypted with the AGENT key (derived from the agent's privkey).
 *     They transfer WITH the iNFT (TEE re-encrypt path).
 *   - slot 'profile' is encrypted with the OPERATOR-derived scoped key
 *     (HKDF over EIP-712 sig, scope `anima-profile-v1`). The agent privkey
 *     alone CANNOT decrypt. Only the CURRENT operator can.
 *
 * Privacy invariant: profile slot purges (zeroed) on `iTransferFrom` so a
 * new operator never inherits the prior operator's data. Already wired in
 * `buildTransferHashes(purgeProfile: true)` default.
 *
 * Sandbox handoff: in deploy=sandbox mode the operator pre-derives the
 * PROFILE scope key on their host once at `anima gateway start`, ships it
 * inside the ECIES-sealed provision envelope. Daemon never sees the
 * operator privkey, only the 32-byte AES scoped key.
 */
export interface ProfileSyncOpts {
  network: AnimaNetwork
  agentPrivkey: Hex
  /** Operator-derived AES key for the PROFILE scope (32 bytes). */
  profileKey: Buffer
  /**
   * v0.24.0: pre-built plaintext bytes for the profile slot. Callers should
   * pass the v2 pack envelope (gathered + encoded by `gatherUserPack` +
   * `encodePackBlob`). v0.23.x callers can keep passing raw `user/profile.md`
   * bytes — the encryption layer is agnostic to envelope vs raw.
   */
  plaintext: Uint8Array
  /** Last successful plaintext hash; null on first flush. */
  lastPlaintextHash: Hex | null
}

export interface ProfileSyncResult {
  uploaded: boolean
  rootHash: Hex | null
  plaintextHash: Hex | null
  reason?: 'missing-file' | 'no-change' | 'uploaded'
}

export async function syncProfile(opts: ProfileSyncOpts): Promise<ProfileSyncResult> {
  const plaintext = opts.plaintext
  if (plaintext.length === 0) {
    return { uploaded: false, rootHash: null, plaintextHash: null, reason: 'missing-file' }
  }
  const plaintextHash = keccak256(plaintext)
  if (plaintextHash === opts.lastPlaintextHash) {
    return { uploaded: false, rootHash: null, plaintextHash, reason: 'no-change' }
  }
  const blob = await encryptOperatorBlob({
    scope: OPERATOR_BLOB_SCOPES.PROFILE,
    plaintext,
    precomputedKey: opts.profileKey,
  })
  const bytes = encodeOperatorBlobBytes(blob)
  const storage = new OGStorage({ network: opts.network, privkeyHex: opts.agentPrivkey })
  const rootHash = (await storage.putBlob(bytes)) as Hex
  return { uploaded: true, rootHash, plaintextHash, reason: 'uploaded' }
}

export interface RestoreProfileOpts {
  network: AnimaNetwork
  rootHash: Hex
  profileKey: Buffer
  profilePath: string
  /**
   * Override the storage download; tests inject a stub. Default behaviour
   * resolves the blob via 0G Storage indexer-aware `downloadBlobByRoot`.
   */
  downloadBlob?: (rootHash: string) => Promise<Uint8Array | null>
}

export async function restoreProfile(opts: RestoreProfileOpts): Promise<{
  status: 'restored' | 'failed'
  reason?: string
  bytes?: number
}> {
  const fetcher = opts.downloadBlob ?? ((root: string) => downloadBlobByRoot(opts.network, root))
  const ciphertext = await fetcher(opts.rootHash).catch(() => null)
  if (!ciphertext) {
    return { status: 'failed', reason: 'blob-not-found' }
  }
  let blob: ReturnType<typeof decodeOperatorBlobBytes>
  try {
    blob = decodeOperatorBlobBytes(ciphertext)
  } catch (e) {
    return { status: 'failed', reason: `decode: ${(e as Error).message.slice(0, 120)}` }
  }
  if (blob.scope !== OPERATOR_BLOB_SCOPES.PROFILE) {
    return { status: 'failed', reason: `wrong-scope: ${blob.scope}` }
  }
  let plaintext: Uint8Array
  try {
    plaintext = await decryptOperatorBlob({
      blob,
      scope: OPERATOR_BLOB_SCOPES.PROFILE,
      agentAddress: '0x0000000000000000000000000000000000000000',
      precomputedKey: opts.profileKey,
    })
  } catch (e) {
    return { status: 'failed', reason: `decrypt: ${(e as Error).message.slice(0, 120)}` }
  }
  await mkdir(dirname(opts.profilePath), { recursive: true })
  await writeFile(opts.profilePath, plaintext)
  return { status: 'restored', bytes: plaintext.length }
}
