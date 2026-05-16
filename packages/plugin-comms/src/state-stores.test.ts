import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { ContactStore } from './contacts'
import { CursorStore } from './cursor'
import { HistoryStore } from './history'
import { ALL_KEY, MuteStore, parseDurationMs } from './mutes'
import { PresenceStore } from './presence'
import { RateLimiter } from './rate-limit'

const ALICE = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const BOB = '0x6B175474E89094C44Da98b954EedeAC495271d0F' as Address

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anima-state-test-'))
}

describe('ContactStore', () => {
  it('add/has/remove roundtrips and persists', () => {
    const d = tempDir()
    const c = new ContactStore(d)
    expect(c.has(ALICE)).toBe(false)
    c.add(ALICE, 'alice')
    expect(c.has(ALICE)).toBe(true)
    expect(c.list()[0]?.name).toBe('alice')
    // reload from disk
    const c2 = new ContactStore(d)
    expect(c2.has(ALICE)).toBe(true)
    expect(c2.remove(ALICE)).toBe(true)
    rmSync(d, { recursive: true, force: true })
  })

  it('first-contact pending then repeat is silent', () => {
    const d = tempDir()
    const c = new ContactStore(d)
    expect(c.recordPending(ALICE)).toBe(true) // first contact
    expect(c.recordPending(ALICE)).toBe(false) // repeat
    expect(c.listPending()[0]?.count).toBe(2)
    rmSync(d, { recursive: true, force: true })
  })

  it('block clears contact + pending; unblock works', () => {
    const d = tempDir()
    const c = new ContactStore(d)
    c.add(ALICE)
    c.recordPending(ALICE)
    c.block(ALICE)
    expect(c.has(ALICE)).toBe(false)
    expect(c.isPending(ALICE)).toBe(false)
    expect(c.isBlocked(ALICE)).toBe(true)
    expect(c.unblock(ALICE)).toBe(true)
    expect(c.isBlocked(ALICE)).toBe(false)
    rmSync(d, { recursive: true, force: true })
  })

  it('approving from pending moves them out', () => {
    const d = tempDir()
    const c = new ContactStore(d)
    c.recordPending(ALICE)
    c.add(ALICE, 'alice')
    expect(c.isPending(ALICE)).toBe(false)
    expect(c.has(ALICE)).toBe(true)
    rmSync(d, { recursive: true, force: true })
  })
})

describe('MuteStore', () => {
  it('per-addr mute fires; unmute clears', () => {
    const d = tempDir()
    const m = new MuteStore(d)
    expect(m.isMuted(ALICE)).toBe(false)
    m.mute(ALICE, null)
    expect(m.isMuted(ALICE)).toBe(true)
    expect(m.unmute(ALICE)).toBe(true)
    expect(m.isMuted(ALICE)).toBe(false)
    rmSync(d, { recursive: true, force: true })
  })

  it('global mute hides everyone', () => {
    const d = tempDir()
    const m = new MuteStore(d)
    m.mute(ALL_KEY, null)
    expect(m.isMuted(ALICE)).toBe(true)
    expect(m.isMuted(BOB)).toBe(true)
    m.unmute(ALL_KEY)
    expect(m.isMuted(ALICE)).toBe(false)
    rmSync(d, { recursive: true, force: true })
  })

  it('timed mute expires automatically on isMuted', () => {
    const d = tempDir()
    const m = new MuteStore(d)
    m.mute(ALICE, 1) // 1ms
    // sleep tiny
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(m.isMuted(ALICE)).toBe(false)
        rmSync(d, { recursive: true, force: true })
        resolve()
      }, 5)
    })
  })

  it('parseDurationMs handles common formats', () => {
    expect(parseDurationMs('30s')).toBe(30_000)
    expect(parseDurationMs('5m')).toBe(300_000)
    expect(parseDurationMs('1h')).toBe(3_600_000)
    expect(parseDurationMs('2d')).toBe(2 * 86_400_000)
    expect(parseDurationMs('1w')).toBe(604_800_000)
    expect(parseDurationMs(null)).toBeNull()
    expect(parseDurationMs('')).toBeNull()
    expect(() => parseDurationMs('garbage')).toThrow()
  })
})

describe('PresenceStore', () => {
  it('away buffers; flip to online flushes count', () => {
    const d = tempDir()
    const p = new PresenceStore(d)
    expect(p.get().state).toBe('online')
    p.set('away', 'lunch')
    expect(p.isAway()).toBe(true)
    p.bump()
    p.bump()
    expect(p.get().buffered).toBe(2)
    const flush = p.set('online')
    expect(flush.flushed).toBe(2)
    expect(p.get().buffered).toBe(0)
    rmSync(d, { recursive: true, force: true })
  })

  it('bump no-op when online', () => {
    const d = tempDir()
    const p = new PresenceStore(d)
    p.bump()
    expect(p.get().buffered).toBe(0)
    rmSync(d, { recursive: true, force: true })
  })
})

describe('RateLimiter', () => {
  it('allows up to capacity, then drops', () => {
    const r = new RateLimiter({ capacity: 3, windowMs: 60_000 })
    expect(r.shouldDrop(ALICE)).toBe(false)
    expect(r.shouldDrop(ALICE)).toBe(false)
    expect(r.shouldDrop(ALICE)).toBe(false)
    expect(r.shouldDrop(ALICE)).toBe(true)
    expect(r.shouldDrop(ALICE)).toBe(true)
  })

  it('isolates per-address counters', () => {
    const r = new RateLimiter({ capacity: 1, windowMs: 60_000 })
    expect(r.shouldDrop(ALICE)).toBe(false)
    expect(r.shouldDrop(BOB)).toBe(false)
    expect(r.shouldDrop(ALICE)).toBe(true)
  })

  it('reset clears counters', () => {
    const r = new RateLimiter({ capacity: 1, windowMs: 60_000 })
    r.shouldDrop(ALICE)
    r.shouldDrop(ALICE)
    r.reset(ALICE)
    expect(r.shouldDrop(ALICE)).toBe(false)
  })
})

describe('CursorStore', () => {
  it('initIfZero only sets on first call', () => {
    const d = tempDir()
    const c = new CursorStore(d)
    expect(c.get()).toBe(0n)
    c.initIfZero(123n)
    expect(c.get()).toBe(123n)
    c.initIfZero(999n)
    expect(c.get()).toBe(123n)
    rmSync(d, { recursive: true, force: true })
  })

  it('set/get roundtrips', () => {
    const d = tempDir()
    const c = new CursorStore(d)
    c.set(31821581n)
    expect(c.get()).toBe(31821581n)
    const c2 = new CursorStore(d)
    expect(c2.get()).toBe(31821581n)
    rmSync(d, { recursive: true, force: true })
  })
})

describe('HistoryStore', () => {
  it('insert + search by peer', () => {
    const d = tempDir()
    const h = new HistoryStore(d)
    h.insert({
      txHash: '0xabc' as Hex,
      logIndex: 0,
      blockNumber: 1,
      fromAddr: ALICE,
      toAddr: BOB,
      direction: 'in',
      type: 'msg',
      content: 'hi bob',
      filename: null,
      mime: null,
      size: null,
      inReplyTo: null,
      ts: 1000,
    })
    h.insert({
      txHash: '0xdef' as Hex,
      logIndex: 0,
      blockNumber: 2,
      fromAddr: BOB,
      toAddr: ALICE,
      direction: 'out',
      type: 'msg',
      content: 'hi alice',
      filename: null,
      mime: null,
      size: null,
      inReplyTo: '0xabc',
      ts: 2000,
    })
    const rows = h.search({ peer: ALICE })
    expect(rows.length).toBe(2)
    expect(rows[0]?.content).toBe('hi alice') // ts DESC
    expect(h.latestWith(ALICE)?.content).toBe('hi alice')
    h.close()
    rmSync(d, { recursive: true, force: true })
  })

  it('threadOf returns thread root + replies', () => {
    const d = tempDir()
    const h = new HistoryStore(d)
    h.insert({
      txHash: '0xroot' as Hex,
      logIndex: 0,
      blockNumber: 1,
      fromAddr: ALICE,
      toAddr: BOB,
      direction: 'in',
      type: 'msg',
      content: 'root',
      filename: null,
      mime: null,
      size: null,
      inReplyTo: null,
      ts: 1000,
    })
    h.insert({
      txHash: '0xreply' as Hex,
      logIndex: 0,
      blockNumber: 2,
      fromAddr: BOB,
      toAddr: ALICE,
      direction: 'out',
      type: 'msg',
      content: 'replying',
      filename: null,
      mime: null,
      size: null,
      inReplyTo: '0xroot',
      ts: 2000,
    })
    const thread = h.threadOf('0xroot')
    expect(thread.length).toBe(2)
    h.close()
    rmSync(d, { recursive: true, force: true })
  })

  it('inserting same (txHash, logIndex) twice is idempotent', () => {
    const d = tempDir()
    const h = new HistoryStore(d)
    const row = {
      txHash: '0xsame' as Hex,
      logIndex: 0,
      blockNumber: 1,
      fromAddr: ALICE,
      toAddr: BOB,
      direction: 'in' as const,
      type: 'msg' as const,
      content: 'one',
      filename: null,
      mime: null,
      size: null,
      inReplyTo: null,
      ts: 1000,
    }
    h.insert(row)
    h.insert({ ...row, content: 'two' })
    const rows = h.search({ peer: ALICE })
    expect(rows.length).toBe(1)
    expect(rows[0]?.content).toBe('one')
    h.close()
    rmSync(d, { recursive: true, force: true })
  })

  it('insert returns true on first insert, false on duplicate (v0.24.11)', () => {
    const d = tempDir()
    const h = new HistoryStore(d)
    const row = {
      txHash: '0xdup' as Hex,
      logIndex: 0,
      blockNumber: 1,
      fromAddr: ALICE,
      toAddr: BOB,
      direction: 'in' as const,
      type: 'msg' as const,
      content: 'first',
      filename: null,
      mime: null,
      size: null,
      inReplyTo: null,
      ts: 1000,
    }
    expect(h.insert(row)).toBe(true)
    // Duplicate (same txHash + logIndex) — listener uses this signal to
    // bail out before re-waking the brain on safety-net catch-up replays.
    expect(h.insert({ ...row, content: 'second-attempt' })).toBe(false)
    // Different logIndex on same tx is a distinct event — must insert.
    expect(h.insert({ ...row, logIndex: 1 })).toBe(true)
    expect(h.search({ peer: ALICE }).length).toBe(2)
    h.close()
    rmSync(d, { recursive: true, force: true })
  })
})
