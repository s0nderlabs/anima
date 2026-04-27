import { describe, expect, it } from 'bun:test'
import { matchBashPattern, matchFilePattern, matchTriggers } from './triggers'
import type { SkillRef } from './types'

describe('matchFilePattern', () => {
  it('matches single glob against basename', () => {
    expect(matchFilePattern('*.test.ts', '/tmp/foo.test.ts')).toBe(true)
    expect(matchFilePattern('*.test.ts', '/tmp/foo.ts')).toBe(false)
  })
  it('matches comma-separated globs', () => {
    expect(matchFilePattern('*.test.ts,*.spec.ts', '/tmp/foo.spec.ts')).toBe(true)
    expect(matchFilePattern('*.test.ts,*.spec.ts', '/tmp/foo.md')).toBe(false)
  })
})

describe('matchBashPattern', () => {
  it('matches regex anywhere in command', () => {
    expect(matchBashPattern('playwright|jest', 'bun run jest tests/')).toBe(true)
    expect(matchBashPattern('playwright|jest', 'go test ./...')).toBe(false)
  })
  it('returns false on invalid regex', () => {
    expect(matchBashPattern('[invalid', 'foo')).toBe(false)
  })
})

function ref(filePattern?: string, bashPattern?: string): SkillRef {
  return {
    id: 'anima:t',
    name: 't',
    description: '',
    path: '/tmp/SKILL.md',
    source: 'anima',
    frontmatter: {
      name: 't',
      description: '',
      ...(filePattern ? { filePattern } : {}),
      ...(bashPattern ? { bashPattern } : {}),
    },
  }
}

describe('matchTriggers', () => {
  it('matches fs.write paths against filePattern', () => {
    const skills = [ref('*.test.ts')]
    const out = matchTriggers(
      { name: 'fs.write', args: { path: '/tmp/foo.test.ts', text: 'x' } },
      skills,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.reason).toBe('filePattern')
  })

  it('matches shell.run commands against bashPattern', () => {
    const skills = [ref(undefined, 'jest')]
    const out = matchTriggers(
      { name: 'shell.run', args: { command: 'bun run jest tests/' } },
      skills,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.reason).toBe('bashPattern')
  })

  it('returns empty when nothing matches', () => {
    const skills = [ref('*.spec.ts'), ref(undefined, 'rspec')]
    const out = matchTriggers(
      { name: 'fs.write', args: { path: '/tmp/foo.md', text: 'x' } },
      skills,
    )
    expect(out).toEqual([])
  })

  it('ignores non-matching tool names', () => {
    const skills = [ref('*.md')]
    const out = matchTriggers({ name: 'memory.save', args: { path: '/tmp/foo.md' } }, skills)
    expect(out).toEqual([])
  })
})
