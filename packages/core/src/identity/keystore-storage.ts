import type { Address, Hex } from 'viem'
import type { AnimaNetwork } from '../config'
import type { OperatorSigner } from '../operator/signer'
import { OGStorage, downloadBlobByRoot } from '../storage'
import {
  decodeKeystoreBytes,
  decryptAgentKey,
  encodeKeystoreBytes,
  encryptAgentKey,
} from '../wallet/operator-keystore-crypto'
import { AnimaAgentNFTClient, AnimaAgentNFTReader, bootstrapHashFor } from './contract'

/**
 * Persist the encrypted agent keystore to 0G Storage and anchor its root hash
 * into the iNFT's `keystore` IntelligentData slot. Called after the agent EOA
 * is funded, before subname/text-record writes, so the agent pays for both the
 * storage upload AND the slot update (via the operator's setApprovalForAll).
 *
 * The keystore itself stays encrypted with the user's passphrase — 0G Storage
 * only holds the opaque encrypted blob. Anyone with the root hash can download
 * it; only the passphrase holder can decrypt.
 *
 * This closes the "hybrid runtime hot copy + iNFT-metadata cold copy" spec gap
 * (project-anima.md section 22). Before this function, the `keystore` slot held
 * a keccak of the bytes (hash-only, no recovery path). After, it holds a 0G
 * Storage root hash that `anima restore <iNFT>` can resolve back to bytes.
 */
export async function persistKeystoreToStorage(opts: {
  network: AnimaNetwork
  agentPrivkey: Hex
  tokenId: bigint
  contractAddress: Address
  /** Encrypted keystore bytes. Caller reads the file once and threads the bytes. */
  keystoreBytes: Uint8Array
}): Promise<{ rootHash: Hex; updateTx: Hex }> {
  const storage = new OGStorage({ network: opts.network, privkeyHex: opts.agentPrivkey })
  const rootHash = (await storage.putBlob(opts.keystoreBytes)) as Hex
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
  return { rootHash, updateTx }
}

/**
 * Restore an agent by fetching the encrypted keystore blob from 0G Storage
 * using the root hash anchored in the iNFT's `keystore` slot. Returns the raw
 * encrypted bytes (caller supplies the passphrase and decrypts).
 *
 * Returns `null` if the slot still holds a bootstrap placeholder or legacy
 * keccak256 hash (i.e. the agent was minted before storage-backed keystores
 * were live, so no blob exists to download). Caller should surface "this agent
 * predates the recovery path; supply a local keystore manually."
 */
/**
 * Re-encrypt the agent keystore for a new operator wallet and upload the new
 * blob to 0G Storage. Returns the new root hash to use in `iTransferFrom`'s
 * `newHashes[]` keystore slot.
 *
 * The agent EOA is unchanged — only the operator-derived AEAD key changes.
 * Existing memory blobs (encrypted with the agent-key memory HKDF) remain
 * decryptable by the recipient because they hold the agent privkey after
 * decrypting the new keystore.
 *
 * Storage gas (~0.02 0G on Galileo, ~0.05 0G on mainnet) is paid by the agent
 * EOA, mirroring the per-turn `MemorySyncManager` flush pattern. The OLD blob
 * stays on 0G Storage (no delete primitive); only the on-chain anchor moves.
 */
export async function reEncryptKeystoreForRecipient(opts: {
  /** Current owner's operator signer; decrypts the existing blob. */
  oldOpSigner: OperatorSigner
  /** Recipient's operator signer; encrypts the new blob. */
  newOpSigner: OperatorSigner
  /** Agent EOA address — the EIP-712 typed-data subject. */
  agentAddress: Address
  /** Current keystore root hash on chain (from `getIntelligentData(tokenId)[4]`). */
  currentRootHash: Hex
  /** Network for both download (read-only) and upload (agent EOA gas). */
  network: AnimaNetwork
  /** Agent's privkey hex — pays gas for the new blob upload. */
  agentPrivkey: Hex
}): Promise<Hex> {
  const encryptedBytes = await downloadBlobByRoot(opts.network, opts.currentRootHash)
  if (!encryptedBytes) {
    throw new Error(
      `reEncryptKeystoreForRecipient: cannot download current keystore blob (root ${opts.currentRootHash}). Aborting before any chain write.`,
    )
  }
  const oldKeystore = decodeKeystoreBytes(encryptedBytes)
  // Decrypt with old operator → recover agent privkey.
  const recoveredPrivkey = await decryptAgentKey({
    signer: opts.oldOpSigner,
    agentAddress: opts.agentAddress,
    keystore: oldKeystore,
  })
  if (recoveredPrivkey.toLowerCase() !== opts.agentPrivkey.toLowerCase()) {
    throw new Error(
      'reEncryptKeystoreForRecipient: decrypted agent privkey does not match the supplied agentPrivkey. Refusing to re-encrypt with mismatched material.',
    )
  }
  // Re-encrypt with new operator → produce new keystore blob.
  const newKeystore = await encryptAgentKey({
    signer: opts.newOpSigner,
    agentAddress: opts.agentAddress,
    agentPrivkey: recoveredPrivkey,
  })
  // Round-trip verify: new blob must decrypt back to the same privkey via
  // the recipient's signer. Catches HKDF/AEAD bugs before chain write.
  const verified = await decryptAgentKey({
    signer: opts.newOpSigner,
    agentAddress: opts.agentAddress,
    keystore: newKeystore,
  })
  if (verified.toLowerCase() !== recoveredPrivkey.toLowerCase()) {
    throw new Error(
      'reEncryptKeystoreForRecipient: round-trip decrypt of new keystore returned wrong privkey. Refusing to upload.',
    )
  }
  const newBytes = encodeKeystoreBytes(newKeystore)
  const storage = new OGStorage({ network: opts.network, privkeyHex: opts.agentPrivkey })
  const rootHash = (await storage.putBlob(newBytes)) as Hex
  if (!rootHash.startsWith('0x') || rootHash.length !== 66) {
    throw new Error(
      `reEncryptKeystoreForRecipient: 0G Storage returned non-bytes32 root (${rootHash.length} chars).`,
    )
  }
  return rootHash
}

export async function restoreKeystoreFromStorage(opts: {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
}): Promise<{ rootHash: Hex; encryptedBytes: Uint8Array; owner: Address } | null> {
  const reader = new AnimaAgentNFTReader({
    network: opts.network,
    contractAddress: opts.contractAddress,
  })
  const [rootHash, owner] = await Promise.all([
    reader.getSlotHash(opts.tokenId, 'keystore'),
    reader.ownerOf(opts.tokenId),
  ])
  if (rootHash === bootstrapHashFor('keystore')) return null
  const encryptedBytes = await downloadBlobByRoot(opts.network, rootHash)
  if (!encryptedBytes) return null
  return { rootHash, encryptedBytes, owner }
}
