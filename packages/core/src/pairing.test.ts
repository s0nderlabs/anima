import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_SECONDS,
  PAIRING_LOCKOUT_SECONDS,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PAIRING_MAX_PENDING_PER_PLATFORM,
  PairingStore,
} from './pairing'

let testDir: string

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'anima-pairing-test-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('PairingStore.generateCode', () => {
  it('returns an 8-char code from the alphabet', () => {
    const store = new PairingStore({ dir: testDir })
    const code = store.generateCode('telegram', '111')
    expect(code).not.toBeNull()
    expect(code!.length).toBe(PAIRING_CODE_LENGTH)
    for (const ch of code!) expect(PAIRING_ALPHABET).toContain(ch)
  })

  it('returns null when MAX_PENDING_PER_PLATFORM reached', () => {
    const store = new PairingStore({ dir: testDir })
    for (let i = 0; i < PAIRING_MAX_PENDING_PER_PLATFORM; i++) {
      const c = store.generateCode('telegram', `user-${i}`)
      expect(c).not.toBeNull()
    }
    const overflow = store.generateCode('telegram', 'user-overflow')
    expect(overflow).toBeNull()
  })

  it('returns null when same user requests within rate limit window', () => {
    const store = new PairingStore({ dir: testDir })
    const a = store.generateCode('telegram', '111')
    expect(a).not.toBeNull()
    const b = store.generateCode('telegram', '111')
    expect(b).toBeNull()
  })

  it('different users on same platform do not rate-limit each other', () => {
    const store = new PairingStore({ dir: testDir })
    expect(store.generateCode('telegram', '111')).not.toBeNull()
    expect(store.generateCode('telegram', '222')).not.toBeNull()
  })

  it('cleans up expired codes before generating', () => {
    let now = 1000
    const store = new PairingStore({ dir: testDir, now: () => now })
    const c1 = store.generateCode('telegram', 'user-1')
    expect(c1).not.toBeNull()
    now += PAIRING_CODE_TTL_SECONDS + 1
    const after = store.listPending('telegram')
    expect(after.length).toBe(0)
  })
})

describe('PairingStore.approveCode', () => {
  it('approves a valid code and adds the user to approved list', () => {
    const store = new PairingStore({ dir: testDir })
    const code = store.generateCode('telegram', '111', 'phantom')!
    const result = store.approveCode('telegram', code)
    expect(result).toEqual({ userId: '111', userName: 'phantom' })
    expect(store.isApproved('telegram', '111')).toBe(true)
  })

  it('removes the code from pending after approval', () => {
    const store = new PairingStore({ dir: testDir })
    const code = store.generateCode('telegram', '111')!
    store.approveCode('telegram', code)
    expect(store.listPending('telegram').length).toBe(0)
  })

  it('returns null for unknown codes', () => {
    const store = new PairingStore({ dir: testDir })
    const result = store.approveCode('telegram', 'WRONGCOD')
    expect(result).toBeNull()
  })

  it('is case-insensitive on the code input', () => {
    const store = new PairingStore({ dir: testDir })
    const code = store.generateCode('telegram', '111')!
    const result = store.approveCode('telegram', code.toLowerCase())
    expect(result?.userId).toBe('111')
  })

  it('trims whitespace from the code input', () => {
    const store = new PairingStore({ dir: testDir })
    const code = store.generateCode('telegram', '111')!
    const result = store.approveCode('telegram', ` ${code} `)
    expect(result?.userId).toBe('111')
  })

  it('locks out platform after MAX_FAILED_ATTEMPTS bad approvals', () => {
    const now = 1000
    const store = new PairingStore({ dir: testDir, now: () => now })
    for (let i = 0; i < PAIRING_MAX_FAILED_ATTEMPTS; i++) {
      expect(store.approveCode('telegram', 'NOTREAL1')).toBeNull()
    }
    expect(store.isLockedOut('telegram')).toBe(true)
    expect(store.generateCode('telegram', '111')).toBeNull()
  })

  it('lockout clears after LOCKOUT_SECONDS', () => {
    let now = 1000
    const store = new PairingStore({ dir: testDir, now: () => now })
    for (let i = 0; i < PAIRING_MAX_FAILED_ATTEMPTS; i++) {
      store.approveCode('telegram', 'NOTREAL1')
    }
    expect(store.isLockedOut('telegram')).toBe(true)
    now += PAIRING_LOCKOUT_SECONDS + 1
    expect(store.isLockedOut('telegram')).toBe(false)
  })

  it('successful approval resets the failure counter', () => {
    const store = new PairingStore({ dir: testDir })
    store.approveCode('telegram', 'NOTREAL1')
    store.approveCode('telegram', 'NOTREAL2')
    const code = store.generateCode('telegram', '111')!
    store.approveCode('telegram', code)
    // Should not reach lockout from prior 2 fails
    for (let i = 0; i < PAIRING_MAX_FAILED_ATTEMPTS - 1; i++) {
      store.approveCode('telegram', 'NOTREALX')
    }
    expect(store.isLockedOut('telegram')).toBe(false)
  })
})

describe('PairingStore.listPending / listApproved / clearPending', () => {
  it('listPending returns codes for one platform', () => {
    const store = new PairingStore({ dir: testDir })
    store.generateCode('telegram', '111', 'a')
    store.generateCode('telegram', '222', 'b')
    const pending = store.listPending('telegram')
    expect(pending.length).toBe(2)
    expect(pending.map(p => p.userId).sort()).toEqual(['111', '222'])
  })

  it('listPending(undefined) aggregates across platforms', () => {
    const store = new PairingStore({ dir: testDir })
    store.generateCode('telegram', '111')
    store.generateCode('discord', '222')
    const pending = store.listPending()
    expect(pending.length).toBe(2)
    const platforms = pending.map(p => p.platform).sort()
    expect(platforms).toEqual(['discord', 'telegram'])
  })

  it('listApproved aggregates across platforms', () => {
    const store = new PairingStore({ dir: testDir })
    const c1 = store.generateCode('telegram', '111', 'a')!
    store.approveCode('telegram', c1)
    const c2 = store.generateCode('discord', '222', 'b')!
    store.approveCode('discord', c2)
    const approved = store.listApproved()
    expect(approved.length).toBe(2)
  })

  it('clearPending removes all pending and returns count', () => {
    const store = new PairingStore({ dir: testDir })
    store.generateCode('telegram', '111')
    store.generateCode('telegram', '222')
    expect(store.clearPending('telegram')).toBe(2)
    expect(store.listPending('telegram').length).toBe(0)
  })

  it('revoke removes an approved user', () => {
    const store = new PairingStore({ dir: testDir })
    const code = store.generateCode('telegram', '111')!
    store.approveCode('telegram', code)
    expect(store.revoke('telegram', '111')).toBe(true)
    expect(store.isApproved('telegram', '111')).toBe(false)
  })

  it('revoke returns false when user is not approved', () => {
    const store = new PairingStore({ dir: testDir })
    expect(store.revoke('telegram', '999')).toBe(false)
  })
})

describe('PairingStore file permissions and atomicity', () => {
  it('writes pending file with 0600 mode on POSIX', () => {
    const store = new PairingStore({ dir: testDir })
    store.generateCode('telegram', '111')
    const path = join(testDir, 'telegram-pending.json')
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).length).toBe(1)
  })

  it('atomic writes leave no .tmp residue on success', () => {
    const store = new PairingStore({ dir: testDir })
    store.generateCode('telegram', '111')
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const files = readdirSync(testDir)
    expect(files.some(f => f.includes('.tmp-'))).toBe(false)
  })
})
