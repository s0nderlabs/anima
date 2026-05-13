import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSyntheticIndexEntries } from './index-sync'

describe('ensureSyntheticIndexEntries', () => {
  let memoryDir: string

  beforeEach(() => {
    memoryDir = mkdtempSync(join(tmpdir(), 'index-sync-'))
    mkdirSync(join(memoryDir, 'agent'), { recursive: true })
    mkdirSync(join(memoryDir, 'user'), { recursive: true })
    writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory\n\n', 'utf8')
  })

  afterEach(() => {
    if (memoryDir) rmSync(memoryDir, { recursive: true, force: true })
  })

  it('adds entries for files that exist on disk with frontmatter descriptions', async () => {
    writeFileSync(
      join(memoryDir, 'agent', 'identity.md'),
      '---\nname: identity\ndescription: Auto-written agent identity facts\ntype: agent-identity\n---\n# id',
    )
    writeFileSync(
      join(memoryDir, 'agent', 'persona.md'),
      '---\nname: persona\ndescription: Voice + behavior style\ntype: agent-persona\n---\nbody',
    )
    writeFileSync(
      join(memoryDir, 'user', 'profile.md'),
      '---\nname: profile\ndescription: User profile\ntype: user\n---\nbody',
    )
    const r = await ensureSyntheticIndexEntries(memoryDir)
    expect(r.added).toEqual(['agent/identity.md', 'agent/persona.md', 'user/profile.md'])
    expect(r.skipped).toEqual([])
    const idx = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    expect(idx).toContain('agent/identity.md')
    expect(idx).toContain('Auto-written agent identity facts')
    expect(idx).toContain('agent/persona.md')
    expect(idx).toContain('user/profile.md')
  })

  it('is idempotent — second call adds nothing', async () => {
    writeFileSync(
      join(memoryDir, 'agent', 'identity.md'),
      '---\nname: identity\ndescription: id desc\ntype: agent-identity\n---\nbody',
    )
    await ensureSyntheticIndexEntries(memoryDir)
    const r2 = await ensureSyntheticIndexEntries(memoryDir)
    expect(r2.added).toEqual([])
    expect(r2.skipped).toContain('agent/identity.md')
  })

  it('skips files that do not exist on disk', async () => {
    // Only persona exists, no identity.md or profile.md.
    writeFileSync(
      join(memoryDir, 'agent', 'persona.md'),
      '---\nname: persona\ndescription: voice\ntype: agent-persona\n---\nbody',
    )
    const r = await ensureSyntheticIndexEntries(memoryDir)
    expect(r.added).toEqual(['agent/persona.md'])
    expect(r.skipped).toEqual(['agent/identity.md', 'user/profile.md'])
  })

  it('falls back to filename title when frontmatter is missing', async () => {
    writeFileSync(join(memoryDir, 'agent', 'identity.md'), 'no frontmatter here')
    const r = await ensureSyntheticIndexEntries(memoryDir)
    expect(r.added).toEqual(['agent/identity.md'])
    const idx = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    expect(idx).toContain('agent/identity.md')
    expect(idx).toContain('identity')
  })

  it('no-ops gracefully when MEMORY.md is missing', async () => {
    rmSync(join(memoryDir, 'MEMORY.md'))
    const r = await ensureSyntheticIndexEntries(memoryDir)
    expect(r.added).toEqual([])
    expect(r.skipped.length).toBe(3)
  })
})
