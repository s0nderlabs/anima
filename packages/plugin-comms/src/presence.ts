import { join } from 'node:path'
import { loadJson, saveJson } from './state-files'

/**
 * Anima's local presence state. When `away`, the listener accumulates inbound
 * messages and skips brain notification; on flip back to `online`, it
 * delivers a single summary instead of dumping N pings.
 */
export type PresenceState = 'online' | 'away'

interface PresenceFile {
  v: 1
  state: PresenceState
  message: string | null
  since: number
  /** Pending count buffered while away. Reset on flip to online. */
  buffered: number
}

const DEFAULT: PresenceFile = {
  v: 1,
  state: 'online',
  message: null,
  since: Date.now(),
  buffered: 0,
}

export class PresenceStore {
  private readonly path: string
  private state: PresenceFile

  constructor(agentDir: string) {
    this.path = join(agentDir, 'comms', 'presence.json')
    this.state = loadJson(this.path, DEFAULT)
  }

  get(): { state: PresenceState; message: string | null; since: number; buffered: number } {
    return { ...this.state }
  }

  set(state: PresenceState, message?: string | null): { flushed: number } {
    const wasAway = this.state.state === 'away'
    const nowOnline = state === 'online'
    const flushed = wasAway && nowOnline ? this.state.buffered : 0
    this.state = {
      v: 1,
      state,
      message: message ?? null,
      since: Date.now(),
      buffered: nowOnline ? 0 : this.state.buffered,
    }
    saveJson(this.path, this.state)
    return { flushed }
  }

  /** Increment the buffered count (caller invokes when in away mode). */
  bump(): void {
    if (this.state.state !== 'away') return
    this.state.buffered++
    saveJson(this.path, this.state)
  }

  isAway(): boolean {
    return this.state.state === 'away'
  }
}
