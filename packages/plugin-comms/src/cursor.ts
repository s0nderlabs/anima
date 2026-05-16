import { join } from 'node:path'
import { loadJson, saveJson } from './state-files'

/**
 * Listener cursor for catch-up. Mirrored to 0G Storage KV alongside memory
 * (Phase 6.7 sync hooks); the local file is a hot cache. The 0G Storage
 * value is canonical for cross-device resume.
 */
interface CursorFile {
  v: 1
  lastSeenBlock: string // bigint as decimal string for JSON safety
  /** Optional starting block; if unset, listener starts from the agent's iNFT mint block. */
  startBlock?: string
}

// NB: returned by-value (fresh literal per call) to avoid shared-default
// mutation aliasing — `state-files.loadJson` returns the fallback by
// reference, so a long-lived default object would get mutated by every
// CursorStore instance that fell back to it.
const defaultCursor = (): CursorFile => ({ v: 1, lastSeenBlock: '0' })

export class CursorStore {
  private readonly path: string
  private state: CursorFile

  constructor(agentDir: string) {
    this.path = join(agentDir, 'comms', 'cursor.json')
    this.state = loadJson(this.path, defaultCursor())
  }

  get(): bigint {
    return BigInt(this.state.lastSeenBlock)
  }

  set(block: bigint): void {
    this.state.lastSeenBlock = block.toString()
    saveJson(this.path, this.state)
  }

  /**
   * Initialize the cursor from `start` if it's been default-zero. Used at
   * first boot to anchor scanning at the agent's iNFT mint block rather
   * than scanning the entire chain.
   */
  initIfZero(start: bigint): void {
    if (this.state.lastSeenBlock === '0') {
      this.state.lastSeenBlock = start.toString()
      this.state.startBlock = start.toString()
      saveJson(this.path, this.state)
    }
  }
}
