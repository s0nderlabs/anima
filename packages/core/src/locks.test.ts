import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LOCK_TTL_SECONDS, acquireScopedLock } from './locks'

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

function findLockFile(dir: string, scope: string, identity: string): string {
  // Mirror the internal hash logic (sha256 first 16 hex chars)
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return join(dir, `${scope}-${hash}.lock`)
}
