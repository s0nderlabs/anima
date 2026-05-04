// Process-scoped advisory locks via PID-file pattern.
//
// Used by long-running listeners (telegram bot poller, etc.) to ensure only
// one process per scope+identity holds the resource. Mirrors hermes's
// acquire_scoped_lock from gateway/status.py.
//
// Lock file lives at ~/.anima/locks/<scope>-<sha256(identity).slice(0,16)>.lock
// O_CREAT|O_EXCL atomic create. Stale-detection via process.kill(pid, 0).
// TTL eviction is a belt-and-suspenders fallback against crashed holders that
// the kernel hasn't reaped yet (rare but real on macOS).

import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AcquireScopedLockOpts {
  scope: string
  identity: string
  ttl?: number
  rootDir?: string
}

export interface ScopedLockHandle {
  releaseFn: () => void
  refreshFn: () => boolean
}

export interface AcquireScopedLockResult {
  acquired: boolean
  handle?: ScopedLockHandle
  existing?: { pid: number; startedAt: number; updatedAt: number }
}

export const DEFAULT_LOCK_TTL_SECONDS = 300

interface LockRecord {
  pid: number
  scope: string
  identityHash: string
  startedAt: number
  updatedAt: number
  ttl: number
}

function lockDir(rootDir?: string): string {
  return rootDir ?? join(homedir(), '.anima', 'locks')
}

function lockPath(scope: string, identity: string, rootDir?: string): string {
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return join(lockDir(rootDir), `${scope}-${hash}.lock`)
}

function readLock(path: string): LockRecord | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockRecord
  } catch {
    return null
  }
}

// process.kill(pid, 0) succeeds against zombie (defunct) processes on Linux
// because the kernel keeps the PID slot until the parent reaps it. A zombie
// can never refresh its lock or service work, so we treat it as gone. See
// feedback-tg-token-lock-zombie-after-upgrade.md. Exported for tests; not
// public API.
export function isZombieLinux(pid: number): boolean {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const m = status.match(/^State:\s+(\S)/m)
    return m?.[1] === 'Z'
  } catch {
    return false
  }
}

function isStale(record: LockRecord, now: number): boolean {
  if (now - record.updatedAt > record.ttl) return true
  if (record.pid === process.pid) return false
  try {
    process.kill(record.pid, 0)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EPERM') return false
    return true
  }
  if (process.platform === 'linux' && isZombieLinux(record.pid)) return true
  return false
}

function attemptOnce(
  path: string,
  scope: string,
  identityHash: string,
  ttl: number,
): AcquireScopedLockResult {
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch {
    const existing = readLock(path)
    const now = Math.floor(Date.now() / 1000)
    if (!existing || isStale(existing, now)) {
      try {
        unlinkSync(path)
      } catch {
        /* race with another reclaimer */
      }
      return { acquired: false }
    }
    return {
      acquired: false,
      existing: {
        pid: existing.pid,
        startedAt: existing.startedAt,
        updatedAt: existing.updatedAt,
      },
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const record: LockRecord = {
    pid: process.pid,
    scope,
    identityHash,
    startedAt: now,
    updatedAt: now,
    ttl,
  }
  try {
    writeSync(fd, JSON.stringify(record))
  } finally {
    closeSync(fd)
  }

  let released = false
  const releaseFn = (): void => {
    if (released) return
    released = true
    try {
      const current = readLock(path)
      if (current?.pid === process.pid) unlinkSync(path)
    } catch {
      /* best-effort */
    }
  }
  const refreshFn = (): boolean => {
    if (released) return false
    try {
      const current = readLock(path)
      if (current?.pid !== process.pid) return false
      const next: LockRecord = { ...current, updatedAt: Math.floor(Date.now() / 1000) }
      const fd2 = openSync(path, 'w')
      try {
        writeSync(fd2, JSON.stringify(next))
      } finally {
        closeSync(fd2)
      }
      return true
    } catch {
      return false
    }
  }
  return { acquired: true, handle: { releaseFn, refreshFn } }
}

export function acquireScopedLock(opts: AcquireScopedLockOpts): AcquireScopedLockResult {
  const ttl = opts.ttl ?? DEFAULT_LOCK_TTL_SECONDS
  const path = lockPath(opts.scope, opts.identity, opts.rootDir)
  mkdirSync(lockDir(opts.rootDir), { recursive: true })
  const identityHash = createHash('sha256').update(opts.identity).digest('hex').slice(0, 16)

  for (let i = 0; i < 3; i++) {
    const result = attemptOnce(path, opts.scope, identityHash, ttl)
    if (result.acquired) return result
    if (result.existing) return result
  }
  return { acquired: false }
}
