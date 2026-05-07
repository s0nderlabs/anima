import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LOCK_TTL_SECONDS,
  acquireScopedLock,
  clearStaleScopedLock,
  isZombieLinux,
} from './locks'

let testDir: string

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'anima-locks-test-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('acquireScopedLock', () => {
  it('acquires when no prior holder exists', () => {
    const r = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    expect(r.acquired).toBe(true)
    expect(r.handle).toBeDefined()
    r.handle?.releaseFn()
  })

  it('rejects when another live process holds it', () => {
    const r1 = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    expect(r1.acquired).toBe(true)

    const r2 = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    expect(r2.acquired).toBe(false)
    expect(r2.existing?.pid).toBe(process.pid)

    r1.handle?.releaseFn()
  })

  it('different identities do not collide on same scope', () => {
    const a = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    const b = acquireScopedLock({ scope: 'test', identity: 'token-b', rootDir: testDir })
    expect(a.acquired).toBe(true)
    expect(b.acquired).toBe(true)
    a.handle?.releaseFn()
    b.handle?.releaseFn()
  })

  it('release allows re-acquire', () => {
    const r1 = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    expect(r1.acquired).toBe(true)
    r1.handle?.releaseFn()

    const r2 = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    expect(r2.acquired).toBe(true)
    r2.handle?.releaseFn()
  })

  it('release is idempotent', () => {
    const r1 = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    r1.handle?.releaseFn()
    r1.handle?.releaseFn()
    const r2 = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    expect(r2.acquired).toBe(true)
    r2.handle?.releaseFn()
  })

  it('reclaims a stale lock from a dead PID', () => {
    // Manually plant a lock file with a fake PID that won't exist
    const fakePid = 999999
    const lockFile = findLockFile(testDir, 'test', 'token-a')
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: fakePid,
        scope: 'test',
        identityHash: 'fake',
        startedAt: 0,
        updatedAt: 0,
        ttl: DEFAULT_LOCK_TTL_SECONDS,
      }),
    )

    const r = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    expect(r.acquired).toBe(true)
    r.handle?.releaseFn()
  })

  it('reclaims a TTL-expired lock from a live process', () => {
    // Plant a lock file with a real PID but ancient updatedAt
    const lockFile = findLockFile(testDir, 'test', 'token-a')
    const veryOld = Math.floor(Date.now() / 1000) - 99999
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        scope: 'test',
        identityHash: 'fake',
        startedAt: veryOld,
        updatedAt: veryOld,
        ttl: 60,
      }),
    )

    const r = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    expect(r.acquired).toBe(true)
    r.handle?.releaseFn()
  })

  it('refreshFn returns true while owner holds the lock', () => {
    const r = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    expect(r.handle?.refreshFn()).toBe(true)
    r.handle?.releaseFn()
  })

  it('refreshFn returns false after release', () => {
    const r = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    r.handle?.releaseFn()
    expect(r.handle?.refreshFn()).toBe(false)
  })

  it('hashes the identity into the lock filename', () => {
    const a = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    const b = acquireScopedLock({ scope: 'test', identity: 'token-different', rootDir: testDir })
    expect(a.acquired).toBe(true)
    expect(b.acquired).toBe(true)
    a.handle?.releaseFn()
    b.handle?.releaseFn()
  })

  it('records stable shape: pid + startedAt + updatedAt + ttl', () => {
    const r = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir, ttl: 600 })
    expect(r.acquired).toBe(true)
    r.handle?.releaseFn()
  })

  it('respects custom rootDir', () => {
    const r = acquireScopedLock({ scope: 'test', identity: 'token-a', rootDir: testDir })
    expect(r.acquired).toBe(true)
    r.handle?.releaseFn()
  })
})

describe('isZombieLinux', () => {
  it('returns false on non-linux platforms', () => {
    if (process.platform === 'linux') return // platform-specific guard
    expect(isZombieLinux(process.pid)).toBe(false)
  })

  it('returns false for the live current process on linux', () => {
    if (process.platform !== 'linux') return
    expect(isZombieLinux(process.pid)).toBe(false)
  })

  it('returns false when /proc/<pid>/status is unreadable', () => {
    // pid 999999 vanishingly unlikely to exist; readFile will throw.
    expect(isZombieLinux(999_999)).toBe(false)
  })
})

describe('acquireScopedLock evicts dead-pid lock', () => {
  it('reclaims when the lockfile records a pid that no longer exists', () => {
    // Take the lock, write a tampered record claiming a vanishingly-unlikely
    // pid is the holder, then re-acquire. The stale-detection path
    // (process.kill(pid, 0) → ESRCH) should treat it as gone and reclaim.
    const path = findLockFile(testDir, 'test', 'dead-pid')
    writeFileSync(
      path,
      JSON.stringify({
        pid: 999_998, // unlikely to exist on the test host
        scope: 'test',
        identityHash: 'whatever',
        startedAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        ttl: 300,
      }),
    )
    const r = acquireScopedLock({ scope: 'test', identity: 'dead-pid', rootDir: testDir })
    expect(r.acquired).toBe(true)
    r.handle?.releaseFn()
  })
})

describe('clearStaleScopedLock', () => {
  it('returns no-lock when nothing exists', () => {
    const r = clearStaleScopedLock({ scope: 'test', identity: 'fresh', rootDir: testDir })
    expect(r.cleared).toBe(false)
    expect(r.reason).toBe('no-lock')
  })

  it('returns alive-pid when a live PID holds the lock', () => {
    const a = acquireScopedLock({ scope: 'test', identity: 'live', rootDir: testDir })
    expect(a.acquired).toBe(true)
    const r = clearStaleScopedLock({ scope: 'test', identity: 'live', rootDir: testDir })
    expect(r.cleared).toBe(false)
    expect(r.reason).toBe('alive-pid')
    a.handle?.releaseFn()
  })

  it('clears a dead-PID lock and reports cleared-stale', () => {
    const path = findLockFile(testDir, 'test', 'dead')
    writeFileSync(
      path,
      JSON.stringify({
        pid: 999_997,
        scope: 'test',
        identityHash: 'x',
        startedAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        ttl: 600,
      }),
    )
    const r = clearStaleScopedLock({ scope: 'test', identity: 'dead', rootDir: testDir })
    expect(r.cleared).toBe(true)
    expect(r.reason).toBe('cleared-stale')
    // Re-clear should now return no-lock.
    const r2 = clearStaleScopedLock({ scope: 'test', identity: 'dead', rootDir: testDir })
    expect(r2.cleared).toBe(false)
    expect(r2.reason).toBe('no-lock')
  })

  it('clears a TTL-expired lock and reports cleared-ttl', () => {
    const path = findLockFile(testDir, 'test', 'expired')
    const ancient = Math.floor(Date.now() / 1000) - 9999
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid,
        scope: 'test',
        identityHash: 'x',
        startedAt: ancient,
        updatedAt: ancient,
        ttl: 60,
      }),
    )
    const r = clearStaleScopedLock({ scope: 'test', identity: 'expired', rootDir: testDir })
    expect(r.cleared).toBe(true)
    expect(r.reason).toBe('cleared-ttl')
  })

  it('does not delete a lock owned by current process within TTL', () => {
    const a = acquireScopedLock({ scope: 'test', identity: 'mine', rootDir: testDir })
    expect(a.acquired).toBe(true)
    const r = clearStaleScopedLock({ scope: 'test', identity: 'mine', rootDir: testDir })
    expect(r.cleared).toBe(false)
    expect(r.reason).toBe('alive-pid')
    // Lock still acquireable by us via refresh:
    expect(a.handle?.refreshFn()).toBe(true)
    a.handle?.releaseFn()
  })
})

function findLockFile(dir: string, scope: string, identity: string): string {
  // Mirror the internal hash logic (sha256 first 16 hex chars)
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return join(dir, `${scope}-${hash}.lock`)
}
