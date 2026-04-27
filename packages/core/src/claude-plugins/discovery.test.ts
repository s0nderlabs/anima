import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverClaudeExtras } from './discovery'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'anima-claude-extras-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('discoverClaudeExtras', () => {
  it('discovers commands + agents from plugin cache layout', async () => {
    const versionDir = join(scratch, 'cache', 'mp', 'plug', '0.1.0')
    await mkdir(join(versionDir, 'commands'), { recursive: true })
    await mkdir(join(versionDir, 'agents'), { recursive: true })
    await writeFile(
      join(versionDir, 'commands', 'setup.md'),
      '---\nname: setup\ndescription: Build pragma\n---\n\n# Setup body\n',
    )
    await writeFile(
      join(versionDir, 'agents', 'thymos.md'),
      '---\nname: thymos\ndescription: scalper\nmodel: sonnet\n---\n\n# Agent body\n',
    )
    const out = await discoverClaudeExtras({
      claudePluginsCacheRoot: join(scratch, 'cache'),
      importsClaudeCode: true,
    })
    expect(out.commands).toHaveLength(1)
    expect(out.commands[0]!).toMatchObject({
      id: 'plug:setup',
      name: 'setup',
      description: 'Build pragma',
      source: { marketplace: 'mp', plugin: 'plug', version: '0.1.0' },
    })
    expect(out.commands[0]!.body).toContain('Setup body')
    expect(out.agents).toHaveLength(1)
    expect(out.agents[0]!).toMatchObject({
      id: 'plug:thymos',
      name: 'thymos',
      model: 'sonnet',
    })
    expect(out.agents[0]!.body).toContain('Agent body')
  })

  it('returns empty when imports.claudeCode is false', async () => {
    const out = await discoverClaudeExtras({
      claudePluginsCacheRoot: join(scratch, 'cache'),
      importsClaudeCode: false,
    })
    expect(out).toEqual({ commands: [], agents: [] })
  })

  it('skips files without frontmatter (still parses but with empty meta)', async () => {
    const versionDir = join(scratch, 'cache', 'mp', 'plug', '0.1.0')
    await mkdir(join(versionDir, 'commands'), { recursive: true })
    await writeFile(join(versionDir, 'commands', 'foo.md'), 'no frontmatter just body')
    const out = await discoverClaudeExtras({
      claudePluginsCacheRoot: join(scratch, 'cache'),
      importsClaudeCode: true,
    })
    expect(out.commands).toHaveLength(1)
    expect(out.commands[0]!.name).toBe('foo')
    expect(out.commands[0]!.body).toBe('no frontmatter just body')
  })
})
