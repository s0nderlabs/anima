import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Tiny JSON file persistence helper. All comms state files share the same
 * shape: load on demand, atomically replace on save, recover from corrupt or
 * missing files by returning the default. No locking; the listener is the
 * only writer per-agent.
 */
export function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function saveJson<T>(path: string, value: T): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}
