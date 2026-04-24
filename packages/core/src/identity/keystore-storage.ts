import type { Address, Hex } from 'viem'
import type { AnimaNetwork } from '../config'
import { OGStorage, downloadBlobByRoot } from '../storage'
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
