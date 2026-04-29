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
  /** Override default retry schedule for the storage fetch path. */
  retry?: { tries?: number; delayMs?: number; backoffMul?: number }
}

const DEFAULT_FETCH_TRIES = 8
const DEFAULT_FETCH_DELAY_MS = 1500
const DEFAULT_FETCH_BACKOFF = 1.5

/**
 * Resolve the inbound ciphertext: either decode the inline payload bytes, or
 * fetch the blob from 0G Storage if `dataHash` is non-zero.
 *
 * 0G Storage is eventually-consistent: a sender's `putBlob` returns when the
 * upload tx mines, but indexer/storage-node replication can lag a few seconds
 * behind. The receiver hits the indexer immediately after seeing the chain
 * event, so the first read often returns null. Retry with exponential backoff
 * so a transient replication lag doesn't drop a message.
 */
export async function resolveInbound(input: ReceiveChannelInput): Promise<Uint8Array> {
  const hasInline = input.payload && input.payload !== '0x' && input.payload.length > 2
  const hasHash = input.dataHash && input.dataHash !== ZERO_DATA_HASH
  if (hasInline && hasHash) {
    return hexToBytes(input.payload)
  }
  if (hasInline) return hexToBytes(input.payload)
  if (!hasHash) throw new Error('inbound message has neither inline payload nor dataHash')

  const tries = input.retry?.tries ?? DEFAULT_FETCH_TRIES
  const baseDelay = input.retry?.delayMs ?? DEFAULT_FETCH_DELAY_MS
  const backoff = input.retry?.backoffMul ?? DEFAULT_FETCH_BACKOFF
  let lastErr: unknown = null
  let delay = baseDelay
  for (let i = 0; i < tries; i++) {
    try {
      return await input.storage.get(input.dataHash)
    } catch (e) {
      lastErr = e
      if (i === tries - 1) break
      await new Promise(r => setTimeout(r, delay))
      delay = Math.floor(delay * backoff)
    }
  }
  throw lastErr ?? new Error(`storage fetch failed after ${tries} tries`)
}
