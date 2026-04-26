import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSkillsList, makeSkillsView } from './skills'

let scratch: string | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'anima-skills-'))
})

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

function roots(scratchDir: string): { animaSkillsRoot: string; claudeSkillsRoot: string } {
  return {
    animaSkillsRoot: join(scratchDir, '.anima', 'skills'),
    claudeSkillsRoot: join(scratchDir, '.claude', 'skills'),
  }
}

async function plant(
  scratchDir: string,
  sub: 'anima' | 'claude',
  name: string,
  fm: string,
): Promise<string> {
  const skillsRoot =
    sub === 'anima'
      ? join(scratchDir, '.anima', 'skills', name)
      : join(scratchDir, '.claude', 'skills', name)
  await mkdir(skillsRoot, { recursive: true })
  const file = join(skillsRoot, 'SKILL.md')
  await writeFile(file, `${fm}\n\n# Skill body for ${name}\n`)
  return file
}

describe('skills.list', () => {
  it('discovers skills from anima and claude paths when claudeCode imports enabled', async () => {
    expect(scratch).toBeDefined()
    await plant(
      scratch!,
      'anima',
      'dogfood',
      '---\nname: dogfood\ndescription: anima skill body\n---',
    )
    await plant(
      scratch!,
      'claude',
      'commit',
      '---\nname: commit\ndescription: claude skill body\n---',
    )
    const tool = makeSkillsList({ importsClaudeCode: true, ...roots(scratch!) })
    const out = await tool.handler({})
    expect(out.ok).toBe(true)
    const skills = (out.data as { skills: { id: string; source: string }[] }).skills
    expect(skills.find(s => s.id === 'anima:dogfood')).toBeDefined()
    expect(skills.find(s => s.id === 'claude-code:commit')).toBeDefined()
  })
  it('filters by source', async () => {
    expect(scratch).toBeDefined()
    await plant(scratch!, 'anima', 'a', '---\nname: a\ndescription: x\n---')
    await plant(scratch!, 'claude', 'b', '---\nname: b\ndescription: y\n---')
    const tool = makeSkillsList({ importsClaudeCode: true, ...roots(scratch!) })
    const out = await tool.handler({ source: 'anima' })
    const skills = (out.data as { skills: { id: string }[] }).skills
    expect(skills).toHaveLength(1)
    expect(skills[0]!.id).toBe('anima:a')
  })
  it('skips claude paths when imports disabled', async () => {
    expect(scratch).toBeDefined()
    await plant(scratch!, 'claude', 'foo', '---\nname: foo\ndescription: x\n---')
    const tool = makeSkillsList({ importsClaudeCode: false, ...roots(scratch!) })
    const out = await tool.handler({})
    const skills = (out.data as { skills: unknown[] }).skills
    expect(skills).toHaveLength(0)
  })
})

describe('skills.view', () => {
  it('reads body for a known skill, returns text + bytes', async () => {
    expect(scratch).toBeDefined()
    await plant(scratch!, 'anima', 'plan', '---\nname: plan\ndescription: x\n---')
    const tool = makeSkillsView({ importsClaudeCode: false, ...roots(scratch!) })
    const out = await tool.handler({ id: 'anima:plan' })
    expect(out.ok).toBe(true)
    expect((out.data as { text: string }).text).toContain('Skill body for plan')
  })
  it('errors on unknown skill id', async () => {
    const tool = makeSkillsView({ importsClaudeCode: false, ...roots(scratch!) })
    const out = await tool.handler({ id: 'anima:nonexistent' })
    expect(out.ok).toBe(false)
  })
})
