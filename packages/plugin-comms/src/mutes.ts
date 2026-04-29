import { join } from 'node:path'
import type { Address } from 'viem'
import { loadJson, saveJson } from './state-files'

/**
 * Mute store. A mute hides inbound messages from the brain queue but still
 * writes them to history. `key === '*'` is the global mute. Numeric expiry
 * (`expiresAt`) supports timed mutes; `null` means indefinite.
 */
interface MuteEntry {
  /** Lowercased address or "*" for global. */
  key: string
  expiresAt: number | null
  setAt: number
}

interface MutesFile {
  v: 1
  entries: Record<string, MuteEntry>
}

const DEFAULT: MutesFile = { v: 1, entries: {} }

export const ALL_KEY = '*'

export class MuteStore {
  private readonly path: string
  private state: MutesFile

  constructor(agentDir: string) {
    this.path = join(agentDir, 'comms', 'mutes.json')
    this.state = loadJson(this.path, DEFAULT)
  }

  /**
   * Mute `addr` (or "*" for global). `durationMs=null` for indefinite.
   */
  mute(addrOrAll: Address | '*', durationMs: number | null): void {
    const key = addrOrAll === ALL_KEY ? ALL_KEY : (addrOrAll as string).toLowerCase()
    this.state.entries[key] = {
      key,
      expiresAt: durationMs === null ? null : Date.now() + durationMs,
      setAt: Date.now(),
    }
    saveJson(this.path, this.state)
  }

  unmute(addrOrAll: Address | '*'): boolean {
    const key = addrOrAll === ALL_KEY ? ALL_KEY : (addrOrAll as string).toLowerCase()
    const had = Boolean(this.state.entries[key])
    delete this.state.entries[key]
    if (had) saveJson(this.path, this.state)
    return had
  }

  /**
   * Returns true if `addr` should be muted. Considers per-addr + global +
   * any TTL expiry; lazily prunes expired entries.
   */
  isMuted(addr: Address): boolean {
    this.pruneExpired()
    if (this.state.entries[ALL_KEY]) return true
    const e = this.state.entries[addr.toLowerCase()]
    return Boolean(e)
  }

  /** Active entries snapshot (for `agent.mutes()` listing). */
  list(): MuteEntry[] {
    this.pruneExpired()
    return Object.values(this.state.entries)
  }

  private pruneExpired(): void {
    const now = Date.now()
    let changed = false
    for (const [k, e] of Object.entries(this.state.entries)) {
      if (e.expiresAt !== null && e.expiresAt <= now) {
        delete this.state.entries[k]
        changed = true
      }
    }
    if (changed) saveJson(this.path, this.state)
  }
}

/**
 * Parse a duration string (`30m`, `1h`, `1d`, `7d`, etc) into milliseconds.
 * Returns null for "indefinite" or empty.
 */
export function parseDurationMs(s: string | null | undefined): number | null {
  if (!s || s.trim().length === 0) return null
  const m = s.trim().match(/^(\d+)\s*([smhdw])$/i)
  if (!m) throw new Error(`invalid duration: ${s}`)
  const n = Number(m[1])
  const unit = (m[2] ?? 'm').toLowerCase()
  const mult: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }
  return n * mult[unit]!
}
