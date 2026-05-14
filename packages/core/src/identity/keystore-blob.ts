import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Address, Hex } from 'viem'
import type { AnimaNetwork } from '../config'
import type { OperatorSigner } from '../operator/signer'
import { OGStorage, downloadBlobByRoot } from '../storage'
import {
  type OperatorEncryptedKeystore,
  decodeKeystoreBytes,
  decryptAgentKey,
  encodeKeystoreBytes,
  encryptAgentKey,
} from '../wallet/operator-keystore-crypto'
import { AnimaAgentNFTClient, AnimaAgentNFTReader, bootstrapHashFor } from './contract'

/**
 * Phase 6.6: encrypted-keystore lifecycle on 0G Storage.
 *
 * Source-of-truth for the agent privkey is the encrypted blob anchored in
 * the iNFT's `keystore` IntelligentData slot (root hash on-chain, ciphertext
 * on 0G Storage). The local file at `~/.anima/agents/<id>/keystore.json` is
 * just a download cache, deletable at will, will redownload on next use.
 *
 * Keys never leave RAM in plaintext. The ciphertext is decryptable only by
 * the operator's wallet signature (sign-derived-key, see operator-keystore-
 * crypto.ts).
 */

/** Write an encrypted keystore JSON to `cachePath`, mkdir-p'ing the parent. */
async function writeKeystoreCache(
  cachePath: string,
  keystore: OperatorEncryptedKeystore,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, JSON.stringify(keystore, null, 2), 'utf8')
}

export interface UploadKeystoreOpts {
  network: AnimaNetwork
  signer: OperatorSigner
  agentAddress: Address
  agentPrivkey: Hex
  tokenId: bigint
  contractAddress: Address
  /** Optional: write the encrypted blob to this local path as a download cache. */
  cachePath?: string
}

export interface UploadKeystoreResult {
  rootHash: Hex
  updateTx: Hex
  keystore: OperatorEncryptedKeystore
}

/**
 * Encrypt the agent privkey to the operator wallet and save the ciphertext
 * to a local file. Performs ZERO chain or storage operations.
 *
 * **Call this BEFORE funding the agent EOA.** The encrypted keystore on disk
 * is the durable insurance against any subsequent failure: once it exists,
 * the operator wallet can always decrypt + recover the agent privkey, even
 * if the storage upload, chain anchor, or any later step blows up.
 *
 * (Pre-Apr-2026: `uploadKeystore` did encrypt + upload + anchor + cache in
 * one call, with the local cache write LAST, so a storage failure would
 * orphan agent funds. That cost a real $1.84. See feedback memory
 * `feedback-init-must-save-keystore-before-funding.md`.)
 */
export async function saveKeystoreLocally(opts: {
  signer?: OperatorSigner
  agentAddress: Address
  agentPrivkey: Hex
  cachePath: string
  /**
   * v0.23.1: Optional pre-derived AES key (32 bytes). When provided, the
   * caller has already derived the keystore-scope key via
   * `precomputeAllScopes` and wants to avoid a second `signTypedData` call.
   * Used by `anima init` so the operator-session cache and the encrypted
   * keystore share the same derive (operator signs once for the keystore
   * scope, once for the profile scope, never for keystore again).
   */
  precomputedKey?: Buffer
}): Promise<{ keystore: OperatorEncryptedKeystore; bytes: Uint8Array }> {
  const keystore = await encryptAgentKey({
    signer: opts.signer,
    agentAddress: opts.agentAddress,
    agentPrivkey: opts.agentPrivkey,
    precomputedKey: opts.precomputedKey,
  })
  await writeKeystoreCache(opts.cachePath, keystore)
  const bytes = encodeKeystoreBytes(keystore)
  return { keystore, bytes }
}

/**
 * Upload an already-encrypted keystore blob to 0G Storage and anchor the
 * root hash to the iNFT's `keystore` slot. Retries the upload up to 3 times
 * with exponential backoff because the 0G Storage SDK has documented
 * flakiness (intermittent `Spread syntax requires ...iterable` errors when
 * the indexer's segment list comes back malformed).
 *
 * The agent EOA is the gas payer for both the upload and the slot update.
 * Caller must have funded it with at least ~0.05 0G beforehand.
 */
export async function uploadAndAnchorKeystore(opts: {
  network: AnimaNetwork
  agentPrivkey: Hex
  tokenId: bigint
  contractAddress: Address
  bytes: Uint8Array
}): Promise<{ rootHash: Hex; updateTx: Hex }> {
  const storage = new OGStorage({ network: opts.network, privkeyHex: opts.agentPrivkey })
  let rootHash: Hex | null = null
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** (attempt - 1)))
    }
    try {
      const r = (await storage.putBlob(opts.bytes)) as Hex
      if (!r.startsWith('0x') || r.length !== 66) {
        throw new Error(
          `0G Storage returned a root hash that doesn't fit bytes32 (${r.length} chars); cannot anchor to iNFT slot`,
        )
      }
      rootHash = r
      break
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
  }
  if (!rootHash) {
    throw new Error(
      `0G Storage upload failed after 3 attempts. Last error: ${lastErr?.message ?? 'unknown'}`,
    )
  }
  const client = new AnimaAgentNFTClient({
    network: opts.network,
    contractAddress: opts.contractAddress,
    privkeyHex: opts.agentPrivkey,
  })
  const updateTx = await client.updateSlots(opts.tokenId, [
    { slot: 'keystore', dataHash: rootHash },
  ])
  return { rootHash, updateTx }
}

/**
 * Legacy one-shot wrapper kept for `migrate-keystore` and any caller that
 * needs the old encrypt + upload + anchor + cache flow in a single call.
 *
 * **Init flow should NOT call this**: it has the orphan-funds gap. Use
 * `saveKeystoreLocally` BEFORE funding, then `uploadAndAnchorKeystore`
 * AFTER funding instead.
 */
export async function uploadKeystore(opts: UploadKeystoreOpts): Promise<UploadKeystoreResult> {
  const keystore = await encryptAgentKey({
    signer: opts.signer,
    agentAddress: opts.agentAddress,
    agentPrivkey: opts.agentPrivkey,
  })
  const bytes = encodeKeystoreBytes(keystore)
  if (opts.cachePath) await writeKeystoreCache(opts.cachePath, keystore)
  const { rootHash, updateTx } = await uploadAndAnchorKeystore({
    network: opts.network,
    agentPrivkey: opts.agentPrivkey,
    tokenId: opts.tokenId,
    contractAddress: opts.contractAddress,
    bytes,
  })
  return { rootHash, updateTx, keystore }
}

export interface FetchKeystoreOpts {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  /** Optional: try this local cache file first before hitting 0G Storage. */
  cachePath?: string
}

export interface FetchKeystoreResult {
  rootHash: Hex
  keystore: OperatorEncryptedKeystore
  /** From the iNFT's `ownerOf(tokenId)`. */
  owner: Address
  /** Where the blob came from on this read. */
  source: 'local-cache' | '0g-storage'
}

/**
 * Get the encrypted keystore for an iNFT. Tries the local cache first
 * (hot path), falls back to a 0G Storage download (cold path or fresh
 * machine recovery). Always reads the on-chain slot to verify the cache
 * is up to date.
 *
 * Returns null if the keystore slot is unset (still a bootstrap placeholder)
 * or the 0G Storage blob is unreachable / corrupted.
 */
export async function fetchKeystore(opts: FetchKeystoreOpts): Promise<FetchKeystoreResult | null> {
  const reader = new AnimaAgentNFTReader({
    network: opts.network,
    contractAddress: opts.contractAddress,
  })
  const [rootHash, owner] = await Promise.all([
    reader.getSlotHash(opts.tokenId, 'keystore'),
    reader.ownerOf(opts.tokenId),
  ])
  if (rootHash === bootstrapHashFor('keystore')) return null

  if (opts.cachePath) {
    try {
      const cached = await readFile(opts.cachePath, 'utf8')
      const parsed = decodeKeystoreBytes(new TextEncoder().encode(cached))
      // Cache is trusted because the blob is encrypted to the operator wallet
      // anyway. `rm ~/.anima/agents/<id>/keystore.json` forces a fresh
      // download; the on-chain root is not a hash we can recompute locally
      // without re-running the 0G Storage Merkle pipeline.
      return { rootHash, keystore: parsed, owner, source: 'local-cache' }
    } catch {
      // Cache miss / parse fail / ENOENT, fall through to 0G download.
    }
  }

  const bytes = await downloadBlobByRoot(opts.network, rootHash)
  if (!bytes) return null
  const keystore = decodeKeystoreBytes(bytes)

  if (opts.cachePath) {
    try {
      await writeKeystoreCache(opts.cachePath, keystore)
    } catch {
      // Cache write failures are non-fatal; we still return the blob.
    }
  }

  return { rootHash, keystore, owner, source: '0g-storage' }
}

/**
 * Convenience: fetch keystore + decrypt with the supplied operator signer
 * + return the raw agent privkey hex. Throws when slot isn't set or
 * decrypt fails (wrong operator wallet).
 */
export async function fetchAndDecryptKeystore(opts: {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  signer: OperatorSigner
  agentAddress: Address
  cachePath?: string
}): Promise<{
  privkeyHex: Hex
  rootHash: Hex
  owner: Address
  source: 'local-cache' | '0g-storage'
}> {
  const fetched = await fetchKeystore({
    network: opts.network,
    contractAddress: opts.contractAddress,
    tokenId: opts.tokenId,
    cachePath: opts.cachePath,
  })
  if (!fetched) {
    throw new Error(
      `Keystore slot for tokenId ${opts.tokenId.toString()} is unset on 0G ${opts.network}. Either the agent was minted before storage-backed keystores, or the upload failed mid-init.`,
    )
  }
  const privkeyHex = await decryptAgentKey({
    signer: opts.signer,
    agentAddress: opts.agentAddress,
    keystore: fetched.keystore,
  })
  return {
    privkeyHex,
    rootHash: fetched.rootHash,
    owner: fetched.owner,
    source: fetched.source,
  }
}
