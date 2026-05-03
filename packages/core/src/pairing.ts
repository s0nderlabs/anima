// DM pairing system — one-time codes for authorizing new platform users.
//
// Ports hermes gateway/pairing.py 1:1 to TypeScript. Operators run
// `anima pairing approve telegram <code>` after the bot DMs an unrecognized
// user a code.
//
// Security:
//  - 8-char codes from 32-char unambiguous alphabet (no 0/O, 1/I)
//  - crypto-secure randomness via randomInt
//  - 1-hour code TTL, max 3 pending per platform
//  - 1 request / user / 10 min rate limit
//  - 1-hour lockout after 5 failed approvals
//  - chmod 0600 on all data files (best-effort on non-POSIX)
//
// Storage layout under `dir`:
//   <platform>-pending.json     pending codes
//   <platform>-approved.json    approved users
//   _rate_limits.json           rate-limit + lockout tracking

import { randomInt } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const PAIRING_CODE_LENGTH = 8
export const PAIRING_CODE_TTL_SECONDS = 3600
export const PAIRING_RATE_LIMIT_SECONDS = 600
export const PAIRING_LOCKOUT_SECONDS = 3600
export const PAIRING_MAX_PENDING_PER_PLATFORM = 3
export const PAIRING_MAX_FAILED_ATTEMPTS = 5

export interface PairingStoreOpts {
  dir: string
  now?: () => number
}

export interface PendingEntry {
  userId: string
  userName: string
  createdAt: number
}

export interface ApprovedEntry {
  userName: string
  approvedAt: number
}

export interface PendingListing {
  platform: string
  code: string
  userId: string
  userName: string
  ageMinutes: number
  createdAt: number
}

export interface ApprovedListing {
  platform: string
  userId: string
  userName: string
  approvedAt: number
}

export interface ApproveResult {
  userId: string
  userName: string
}

export class PairingStore {
  readonly #dir: string
  readonly #now: () => number

  constructor(opts: PairingStoreOpts) {
    this.#dir = opts.dir
    this.#now = opts.now ?? (() => Date.now() / 1000)
    mkdirSync(this.#dir, { recursive: true })
  }

  isApproved(platform: string, userId: string): boolean {
    const approved = this.#loadJson<Record<string, ApprovedEntry>>(this.#approvedPath(platform))
    return userId in approved
  }

  listApproved(platform?: string): ApprovedListing[] {
    const platforms = platform ? [platform] : this.#allPlatforms('approved')
    const out: ApprovedListing[] = []
    for (const p of platforms) {
      const approved = this.#loadJson<Record<string, ApprovedEntry>>(this.#approvedPath(p))
      for (const [uid, info] of Object.entries(approved)) {
        out.push({ platform: p, userId: uid, userName: info.userName, approvedAt: info.approvedAt })
      }
    }
    return out
  }

  generateCode(platform: string, userId: string, userName = ''): string | null {
    this.#cleanupExpired(platform)
    if (this.#isLockedOut(platform)) return null
    if (this.#isRateLimited(platform, userId)) return null
    const pending = this.#loadJson<Record<string, PendingEntry>>(this.#pendingPath(platform))
    if (Object.keys(pending).length >= PAIRING_MAX_PENDING_PER_PLATFORM) return null

    let code = ''
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
      code += PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)]
    }

    pending[code] = { userId, userName, createdAt: this.#now() }
    this.#saveJson(this.#pendingPath(platform), pending)
    this.#recordRateLimit(platform, userId)
    return code
  }

  approveCode(platform: string, code: string): ApproveResult | null {
    this.#cleanupExpired(platform)
    const normalized = code.toUpperCase().trim()
    const pending = this.#loadJson<Record<string, PendingEntry>>(this.#pendingPath(platform))
    const entry = pending[normalized]
    if (!entry) {
      this.#recordFailedAttempt(platform)
      return null
    }
    delete pending[normalized]
    this.#saveJson(this.#pendingPath(platform), pending)

    const approved = this.#loadJson<Record<string, ApprovedEntry>>(this.#approvedPath(platform))
    approved[entry.userId] = { userName: entry.userName, approvedAt: this.#now() }
    this.#saveJson(this.#approvedPath(platform), approved)

    this.#clearFailedAttempts(platform)
    return { userId: entry.userId, userName: entry.userName }
  }

  listPending(platform?: string): PendingListing[] {
    const platforms = platform ? [platform] : this.#allPlatforms('pending')
    const out: PendingListing[] = []
    for (const p of platforms) {
      this.#cleanupExpired(p)
      const pending = this.#loadJson<Record<string, PendingEntry>>(this.#pendingPath(p))
      for (const [code, info] of Object.entries(pending)) {
        const ageMinutes = Math.floor((this.#now() - info.createdAt) / 60)
        out.push({
          platform: p,
          code,
          userId: info.userId,
          userName: info.userName,
          ageMinutes,
          createdAt: info.createdAt,
        })
      }
    }
    return out
  }

  clearPending(platform?: string): number {
    const platforms = platform ? [platform] : this.#allPlatforms('pending')
    let count = 0
    for (const p of platforms) {
      const pending = this.#loadJson<Record<string, PendingEntry>>(this.#pendingPath(p))
      count += Object.keys(pending).length
      this.#saveJson(this.#pendingPath(p), {})
    }
    return count
  }

  revoke(platform: string, userId: string): boolean {
    const path = this.#approvedPath(platform)
    const approved = this.#loadJson<Record<string, ApprovedEntry>>(path)
    if (!(userId in approved)) return false
    delete approved[userId]
    this.#saveJson(path, approved)
    return true
  }

  isLockedOut(platform: string): boolean {
    return this.#isLockedOut(platform)
  }

  // ----- private helpers -----

  #pendingPath(platform: string): string {
    return join(this.#dir, `${platform}-pending.json`)
  }
  #approvedPath(platform: string): string {
    return join(this.#dir, `${platform}-approved.json`)
  }
  #rateLimitPath(): string {
    return join(this.#dir, '_rate_limits.json')
  }

  #loadJson<T>(path: string): T {
    if (!existsSync(path)) return {} as T
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T
    } catch {
      return {} as T
    }
  }

  #saveJson(path: string, data: unknown): void {
    const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
    try {
      chmodSync(path, 0o600)
    } catch {
      // non-POSIX; permissions are advisory only
    }
  }

  #cleanupExpired(platform: string): void {
    const path = this.#pendingPath(platform)
    if (!existsSync(path)) return
    const pending = this.#loadJson<Record<string, PendingEntry>>(path)
    const now = this.#now()
    let changed = false
    for (const [code, info] of Object.entries(pending)) {
      if (now - info.createdAt > PAIRING_CODE_TTL_SECONDS) {
        delete pending[code]
        changed = true
      }
    }
    if (changed) this.#saveJson(path, pending)
  }

  #isRateLimited(platform: string, userId: string): boolean {
    const limits = this.#loadJson<Record<string, number>>(this.#rateLimitPath())
    const last = limits[`${platform}:${userId}`] ?? 0
    return this.#now() - last < PAIRING_RATE_LIMIT_SECONDS
  }

  #recordRateLimit(platform: string, userId: string): void {
    const limits = this.#loadJson<Record<string, number>>(this.#rateLimitPath())
    limits[`${platform}:${userId}`] = this.#now()
    this.#saveJson(this.#rateLimitPath(), limits)
  }

  #isLockedOut(platform: string): boolean {
    const limits = this.#loadJson<Record<string, number>>(this.#rateLimitPath())
    const lockoutUntil = limits[`_lockout:${platform}`] ?? 0
    return this.#now() < lockoutUntil
  }

  #recordFailedAttempt(platform: string): void {
    const limits = this.#loadJson<Record<string, number>>(this.#rateLimitPath())
    const failKey = `_failures:${platform}`
    const fails = (limits[failKey] ?? 0) + 1
    limits[failKey] = fails
    if (fails >= PAIRING_MAX_FAILED_ATTEMPTS) {
      limits[`_lockout:${platform}`] = this.#now() + PAIRING_LOCKOUT_SECONDS
      limits[failKey] = 0
    }
    this.#saveJson(this.#rateLimitPath(), limits)
  }

  #clearFailedAttempts(platform: string): void {
    const limits = this.#loadJson<Record<string, number>>(this.#rateLimitPath())
    if (`_failures:${platform}` in limits) {
      delete limits[`_failures:${platform}`]
      this.#saveJson(this.#rateLimitPath(), limits)
    }
  }

  #allPlatforms(suffix: 'pending' | 'approved'): string[] {
    if (!existsSync(this.#dir)) return []
    const entries = readdirSync(this.#dir)
    const tail = `-${suffix}.json`
    const platforms = new Set<string>()
    for (const f of entries) {
      if (f.endsWith(tail)) {
        const p = f.slice(0, -tail.length)
        if (!p.startsWith('_')) platforms.add(p)
      }
    }
    return Array.from(platforms)
  }
}
