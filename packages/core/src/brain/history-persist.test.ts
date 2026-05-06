import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsHistoryPersist, sanitizeChannelKey } from './history-persist'
import type { BrainMessage } from './types'

const u = (content: string): BrainMessage => ({ role: 'user', content })
const a = (content: string): BrainMessage => ({ role: 'assistant', content })

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'anima-history-test-'))
}

describe('sanitizeChannelKey', () => {
  it('passes safe keys through', () => {
    expect(sanitizeChannelKey('default')).toBe('default')
    expect(sanitizeChannelKey('tui:stdin')).toBe('tui_stdin')
    expect(sanitizeChannelKey('a-b_c.d')).toBe('a-b_c.d')
  })

  it('replaces unsafe chars', () => {
    expect(sanitizeChannelKey('agent:specter:telegram:dm:12345')).toBe(
      'agent_specter_telegram_dm_12345',
    )
    expect(sanitizeChannelKey('a/b\\c')).toBe('a_b_c')
  })

  it('caps length', () => {
    const long = 'x'.repeat(500)
    const out = sanitizeChannelKey(long)
    expect(out.length).toBeLessThanOrEqual(200)
  })

  it('falls back to default on empty/all-unsafe', () => {
    expect(sanitizeChannelKey('')).toBe('default')
    // 250 unsafe chars → all replaced with _, then sliced to 200, still non-empty so kept
    expect(sanitizeChannelKey('/'.repeat(250)).length).toBe(200)
  })
})

describe('createFsHistoryPersist', () => {
  it('roundtrips a single channel', async () => {
    const dir = makeTmpDir()
    const persist = createFsHistoryPersist({ dir })
    await persist.appendTurn('default', u('hi'), a('hello'))
    const loaded = await persist.loadAll()
    expect(loaded.get('default')).toEqual([u('hi'), a('hello')])
  })

  it('partitions per channel', async () => {
    const dir = makeTmpDir()
    const persist = createFsHistoryPersist({ dir })
    await persist.appendTurn('tui:stdin', u('A'), a('B'))
    await persist.appendTurn('agent:foo:tg:dm:1', u('C'), a('D'))
    const loaded = await persist.loadAll()
    expect(loaded.get('tui:stdin')).toEqual([u('A'), a('B')])
    expect(loaded.get('agent:foo:tg:dm:1')).toEqual([u('C'), a('D')])
  })

  it('appends append onto existing file', async () => {
    const dir = makeTmpDir()
    const persist = createFsHistoryPersist({ dir })
    await persist.appendTurn('default', u('1'), a('2'))
    await persist.appendTurn('default', u('3'), a('4'))
    const loaded = await persist.loadAll()
    expect(loaded.get('default')).toEqual([u('1'), a('2'), u('3'), a('4')])
  })

  it('clearChannel removes the file', async () => {
    const dir = makeTmpDir()
    const persist = createFsHistoryPersist({ dir })
    await persist.appendTurn('default', u('x'), a('y'))
    await persist.clearChannel('default')
    const loaded = await persist.loadAll()
    expect(loaded.get('default')).toBeUndefined()
  })

  it('clearChannel is idempotent on missing file', async () => {
    const dir = makeTmpDir()
    const persist = createFsHistoryPersist({ dir })
    await persist.clearChannel('never-existed')
    // No throw
    expect(true).toBe(true)
  })

  it('rewriteChannel atomically replaces history', async () => {
    const dir = makeTmpDir()
    const persist = createFsHistoryPersist({ dir })
    await persist.appendTurn('default', u('old1'), a('old2'))
    await persist.appendTurn('default', u('old3'), a('old4'))
    await persist.rewriteChannel('default', [u('SUMMARY'), u('new'), a('reply')])
    const loaded = await persist.loadAll()
    expect(loaded.get('default')).toEqual([u('SUMMARY'), u('new'), a('reply')])
  })

  it('loadAll returns empty Map when dir does not exist', async () => {
    const persist = createFsHistoryPersist({ dir: '/nonexistent/path/anima-test' })
    const loaded = await persist.loadAll()
    expect(loaded.size).toBe(0)
  })

  it('loadAll skips malformed lines', async () => {
    const dir = makeTmpDir()
    const persist = createFsHistoryPersist({ dir })
    await persist.appendTurn('default', u('good'), a('reply'))
    // Append a bad line manually
    const path = join(dir, 'default.jsonl')
    const { writeFileSync } = await import('node:fs')
    const existing = readFileSync(path, 'utf8')
    writeFileSync(path, `${existing}not-json\n`)
    const loaded = await persist.loadAll()
    expect(loaded.get('default')).toEqual([u('good'), a('reply')])
  })

  it('loadAll skips records with wrong version', async () => {
    const dir = makeTmpDir()
    const path = join(dir, 'default.jsonl')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path,
      `${JSON.stringify({ v: 999, channelKey: 'default', message: u('x'), ts: 1 })}\n`,
    )
    const persist = createFsHistoryPersist({ dir })
    const loaded = await persist.loadAll()
    expect(loaded.get('default')).toBeUndefined()
  })
})
