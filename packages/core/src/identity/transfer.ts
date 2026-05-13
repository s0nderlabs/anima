/**
 * ERC-7857 intelligent transfer: oracle-signed proof + atomic slot rewrite +
 * ownership change. Pairs with `AnimaAgentNFT.iTransferFrom` in the contract.
 *
 * Three building blocks:
 *  - `transferProofPreimage`: keccak256(abi.encode(...)) of the tuple the
 *    contract recovers against. This IS the bytes32 stored in `consumedProofs`.
 *  - `signTransferProof`: oracle signs the preimage with eth_sign prefix
 *    (matches `MessageHashUtils.toEthSignedMessageHash` in the contract).
 *  - `buildTransferHashes`: assembles the 6-element `newHashes[]` array that
 *    iTransferFrom writes back into all IntelligentData slots. Memory slots
 *    pass through unchanged (agent EOA + agent-key memory HKDF stay stable
 *    across transfer); keystore slot gets the new re-encrypted root hash;
 *    profile slot is purged to its bootstrap placeholder by default.
 */

import { type Address, type Hex, encodeAbiParameters, keccak256 } from 'viem'
import type { OperatorSigner } from '../operator/signer'
import { bootstrapHashFor } from './contract'
import { INTELLIGENT_DATA_SLOTS, slotIndex } from './intelligent-data'

/** Args for both preimage computation and signing. */
export interface TransferProofPreimageArgs {
  tokenId: bigint
  from: Address
  to: Address
  /** Six-element array in canonical `INTELLIGENT_DATA_SLOTS` order. */
  newHashes: readonly Hex[]
  chainId: number
  /** Random bytes32. Must be unique per attempt; replay-protected on chain. */
  proofNonce: Hex
  /** The AnimaAgentNFT contract address (`address(this)` in Solidity). */
  contractAddress: Address
}

/**
 * The 32-byte preimage hash the oracle signs. Same value the contract stores
 * in `consumedProofs` to prevent replay.
 */
export function transferProofPreimage(args: TransferProofPreimageArgs): Hex {
  if (args.newHashes.length !== INTELLIGENT_DATA_SLOTS.length) {
    throw new Error(
      `transferProofPreimage: newHashes must have ${INTELLIGENT_DATA_SLOTS.length} elements (got ${args.newHashes.length})`,
    )
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32[]' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'address' },
      ],
      [
        args.tokenId,
        args.from,
        args.to,
        [...args.newHashes],
        BigInt(args.chainId),
        args.proofNonce,
        args.contractAddress,
      ],
    ),
  )
}

/**
 * Sign the preimage with the eth_sign prefix that the contract's
 * `MessageHashUtils.toEthSignedMessageHash` applies before recover. viem's
 * `signMessage({ message: { raw } })` wraps the raw bytes in
 * `\x19Ethereum Signed Message:\n32` automatically.
 *
 * The returned signature is what gets passed as `oracleSignature` to
 * `iTransferFrom`. Oracle = whichever address `teeOracle()` returns; in MVP
 * that's the same wallet as the iNFT owner (operator), so both halves of
 * the transfer (tx send + oracle proof) come from the same signer.
 */
export async function signTransferProof(
  args: TransferProofPreimageArgs,
  oracleSigner: OperatorSigner,
): Promise<Hex> {
  const preimage = transferProofPreimage(args)
  const account = await oracleSigner.account()
  return await account.signMessage({ message: { raw: preimage } })
}

export interface BuildTransferHashesArgs {
  /**
   * Six-element array of current slot hashes, in canonical order. Caller
   * fetches via `AnimaAgentNFTReader.getIntelligentData(tokenId)`.
   */
  currentHashes: readonly Hex[]
  /** New 0G Storage root hash for the re-encrypted keystore blob. */
  newKeystoreHash: Hex
  /**
   * If true (default), the `profile` slot is reset to its bootstrap placeholder
   * so any operator-scoped data anchored there does NOT cross the transfer
   * boundary (privacy-preserving handoff per project-anima.md section 26.3).
   * Set to false to pass profile through unchanged.
   */
  purgeProfile?: boolean
}

/**
 * Assemble the 6-element `newHashes[]` array iTransferFrom expects.
 *
 * Layout (canonical INTELLIGENT_DATA_SLOTS order):
 *   0 memory-index   passthrough  (agent-key memory HKDF stable across transfer)
 *   1 identity       passthrough
 *   2 persona        passthrough
 *   3 profile        purge → bootstrapHashFor('profile')   (default; opt-out)
 *   4 keystore       new re-encrypted root hash
 *   5 activity-log   passthrough
 */
export function buildTransferHashes(args: BuildTransferHashesArgs): readonly Hex[] {
  if (args.currentHashes.length !== INTELLIGENT_DATA_SLOTS.length) {
    throw new Error(
      `buildTransferHashes: currentHashes must have ${INTELLIGENT_DATA_SLOTS.length} elements (got ${args.currentHashes.length})`,
    )
  }
  const purge = args.purgeProfile ?? true
  const out: Hex[] = [...args.currentHashes]
  out[slotIndex('keystore')] = args.newKeystoreHash
  if (purge) {
    out[slotIndex('profile')] = bootstrapHashFor('profile')
  }
  return out
}
