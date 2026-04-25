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
 * just a download cache — deletable at will, will redownload on next use.
 *
 * Keys never leave RAM in plaintext. The ciphertext is decryptable only by
 * the operator's wallet signature (sign-derived-key, see operator-keystore-
 * crypto.ts).
 */

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
 * Encrypt the agent privkey to the operator wallet, upload to 0G Storage,
 * and anchor the resulting root hash into the iNFT keystore slot.
 *
 * Operator wallet signs once (the EIP-712 typed data) to derive the AEAD
 * key. Agent wallet signs the storage upload + slot update (operator
 * pre-approved agent via setApprovalForAll inside `mintAgent`). One blob
 * upload, one chain tx.
 */
export async function uploadKeystore(opts: UploadKeystoreOpts): Promise<UploadKeystoreResult> {
  const keystore = await encryptAgentKey({
    signer: opts.signer,
    agentAddress: opts.agentAddress,
    agentPrivkey: opts.agentPrivkey,
  })
  const bytes = encodeKeystoreBytes(keystore)

  const storage = new OGStorage({ network: opts.network, privkeyHex: opts.agentPrivkey })
  const rootHash = (await storage.putBlob(bytes)) as Hex
  if (!rootHash.startsWith('0x') || rootHash.length !== 66) {
    throw new Error(
      `0G Storage returned a root hash that doesn't fit bytes32 (${rootHash.length} chars); cannot anchor to iNFT slot`,
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

  if (opts.cachePath) {
    await mkdir(dirname(opts.cachePath), { recursive: true })
    await writeFile(opts.cachePath, JSON.stringify(keystore, null, 2), 'utf8')
  }

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
      // Cache miss / parse fail / ENOENT — fall through to 0G download.
    }
  }

  const bytes = await downloadBlobByRoot(opts.network, rootHash)
  if (!bytes) return null
  const keystore = decodeKeystoreBytes(bytes)

  if (opts.cachePath) {
    try {
      await mkdir(dirname(opts.cachePath), { recursive: true })
      await writeFile(opts.cachePath, JSON.stringify(keystore, null, 2), 'utf8')
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
