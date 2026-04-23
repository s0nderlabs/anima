/**
 * Storage interface abstracting 0G Storage's three primitives as used by anima:
 *   - KV: mutable key→value per namespace
 *   - Log: append-only, returns CID per entry
 *   - Blob: immutable bytes, content-addressed
 *
 * Phase 1 ships a local-disk stub. Phase 5 ships the real @0gfoundation/0g-ts-sdk
 * backend + on-chain-event replay for KV reads (per verified architecture).
 */
export interface Storage {
  /** Put a value into a named stream under a key. */
  putKV(streamId: string, key: string, value: Uint8Array): Promise<void>
  /** Get the latest value for (streamId, key) or null. */
  getKV(streamId: string, key: string): Promise<Uint8Array | null>
  /** Append an entry to a stream's log. Returns CID (rootHash) of the entry. */
  appendLog(streamId: string, entry: Uint8Array): Promise<string>
  /** Upload immutable bytes, returns content CID. */
  putBlob(bytes: Uint8Array): Promise<string>
  /** Retrieve bytes by CID. */
  getBlob(cid: string): Promise<Uint8Array | null>
}
