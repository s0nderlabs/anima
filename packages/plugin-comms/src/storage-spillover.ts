import { type Hex, bytesToHex, hexToBytes } from 'viem'

/**
 * Threshold above which an inline ciphertext payload is offloaded to 0G
 * Storage and only the dataHash is emitted in the contract event. Keeps
 * the gas cost of typical chat under one tx and forces large/binary content
 * through the storage path. The contract enforces a hard ceiling at 16 KiB;
 * this app-layer threshold sits well below that.
 */
export const INLINE_CIPHERTEXT_THRESHOLD = 3 * 1024

/**
 * `0x0` sentinel meaning "no offloaded blob, payload is inline".
 */
export const ZERO_DATA_HASH: Hex = `0x${'00'.repeat(32)}` as Hex

/**
 * Storage uploader/fetcher abstraction. The plugin doesn't import 0G Storage
 * SDK directly; the runtime supplies a function that already knows how to
 * upload/fetch via the agent's KV/blob backend.
 */
export interface StorageUploader {
  put(bytes: Uint8Array): Promise<Hex> // returns dataHash (0x...)
  get(dataHash: Hex): Promise<Uint8Array>
}

export interface SendChannelInput {
  ciphertext: Uint8Array
  storage: StorageUploader
  forceStorage?: boolean
}

export interface SendChannelResult {
  payload: Hex
  dataHash: Hex
}

/**
 * Decide inline vs 0G Storage path based on ciphertext size and emit the
 * right contract args.
 */
export async function buildSendArgs(input: SendChannelInput): Promise<SendChannelResult> {
  const useStorage =
    input.forceStorage || input.ciphertext.byteLength >= INLINE_CIPHERTEXT_THRESHOLD
  if (useStorage) {
    const dataHash = await input.storage.put(input.ciphertext)
    return { payload: '0x' as Hex, dataHash }
  }
  return { payload: bytesToHex(input.ciphertext), dataHash: ZERO_DATA_HASH }
}

export interface ReceiveChannelInput {
  payload: Hex
  dataHash: Hex
  storage: StorageUploader
}

/**
 * Resolve the inbound ciphertext: either decode the inline payload bytes, or
 * fetch the blob from 0G Storage if `dataHash` is non-zero.
 */
export async function resolveInbound(input: ReceiveChannelInput): Promise<Uint8Array> {
  const hasInline = input.payload && input.payload !== '0x' && input.payload.length > 2
  const hasHash = input.dataHash && input.dataHash !== ZERO_DATA_HASH
  if (hasInline && hasHash) {
    // Both set: inline payload is the source of truth (sender chose to
    // include both for some reason; treat extra dataHash as opaque metadata).
    return hexToBytes(input.payload)
  }
  if (hasInline) return hexToBytes(input.payload)
  if (hasHash) return await input.storage.get(input.dataHash)
  throw new Error('inbound message has neither inline payload nor dataHash')
}
