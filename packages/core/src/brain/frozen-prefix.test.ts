import { expect, test } from 'bun:test'
import { buildFrozenPrefix, renderFrozenPrefix, renderUserContext } from './frozen-prefix'

test('buildFrozenPrefix without memory index returns system prompt + session', () => {
  const p = buildFrozenPrefix({ memoryIndex: null, timestamp: null })
  expect(p.memoryIndexText).toBeNull()
  expect(p.systemPrompt.length).toBeGreaterThan(0)
  expect(renderFrozenPrefix(p)).toBe(`${p.systemPrompt}\n`)
})

test('buildFrozenPrefix with memory index puts it in renderUserContext, NOT system prompt', () => {
  const memoryIndex = {
    lines: ['# agent-id — Memory Index', '', '## Memories', '', '- [foo](agent/foo.md) — hello'],
    entries: new Map(),
  }
  const p = buildFrozenPrefix({ memoryIndex, timestamp: null })
  const sys = renderFrozenPrefix(p)
  expect(sys).not.toContain('MEMORY.md (index)')
  const ctx = renderUserContext(p)
  expect(ctx).not.toBeNull()
  expect(ctx!).toContain('MEMORY.md (index)')
  expect(ctx!).toContain('foo')
  expect(ctx!).toContain('<system-reminder>')
})

test('buildFrozenPrefix accepts custom system prompt', () => {
  const p = buildFrozenPrefix({ systemPrompt: 'custom.', memoryIndex: null, timestamp: null })
  expect(renderFrozenPrefix(p)).toBe('custom.\n')
})

test('buildFrozenPrefix loads identity + persona content into prefix', () => {
  const p = buildFrozenPrefix({
    memoryIndex: null,
    identity: '# I am agent #42',
    persona: '# I am terse',
    timestamp: null,
  })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('Identity (canonical')
  expect(rendered).toContain('I am agent #42')
  expect(rendered).toContain('Persona (voice')
  expect(rendered).toContain('I am terse')
})

test('buildFrozenPrefix appends per-tool guidance for loaded tools only', () => {
  const p = buildFrozenPrefix({
    memoryIndex: null,
    loadedToolNames: ['memory.save', 'memory.read'],
    timestamp: null,
  })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('Save durable facts using `memory.save` proactively')
  expect(rendered).toContain('call `memory.read`')
  // No guidance for unknown tools
  const p2 = buildFrozenPrefix({
    memoryIndex: null,
    loadedToolNames: ['unknown.tool'],
    timestamp: null,
  })
  expect(p2.toolGuidance).toEqual([])
})

test('buildFrozenPrefix includes session timestamp by default', () => {
  const p = buildFrozenPrefix({ memoryIndex: null })
  expect(p.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(renderFrozenPrefix(p)).toContain('Session started:')
})

test('renderUserContext returns null when nothing to inject', () => {
  const p = buildFrozenPrefix({ memoryIndex: null, timestamp: null })
  expect(renderUserContext(p)).toBeNull()
})

test('buildFrozenPrefix filters claude-code agent-browser skill out of the index', () => {
  const skills = [
    {
      id: 'claude-code:agent-browser',
      name: 'agent-browser',
      description: 'Automates browser interactions',
      path: '/x/SKILL.md',
      source: 'claude-code' as const,
      frontmatter: { name: 'agent-browser', description: 'Automates browser interactions' },
    },
    {
      id: 'claude-code:hakr',
      name: 'hakr',
      description: 'Hacker News CLI',
      path: '/y/SKILL.md',
      source: 'claude-code' as const,
      frontmatter: { name: 'hakr', description: 'Hacker News CLI' },
    },
  ]
  const p = buildFrozenPrefix({ memoryIndex: null, timestamp: null, skills })
  expect(p.skillIndexText).toContain('hakr')
  expect(p.skillIndexText).not.toContain('agent-browser')
  expect(p.skillIndexText).not.toContain('claude-code:agent-browser')
})

test('buildFrozenPrefix injects browser guidance when browser.navigate is loaded', () => {
  const p = buildFrozenPrefix({
    memoryIndex: null,
    timestamp: null,
    loadedToolNames: ['browser.navigate'],
  })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('browser.navigate')
  expect(rendered).toContain('headless Chromium')
  expect(rendered).toContain('agent-browser')
})

test('skill-shadow filter keeps anima-source skills with the same name', () => {
  const skills = [
    {
      id: 'anima:browser',
      name: 'browser',
      description: 'Anima native browser playbook',
      path: '/z/SKILL.md',
      source: 'anima' as const,
      frontmatter: { name: 'browser', description: 'Anima native browser playbook' },
    },
  ]
  const p = buildFrozenPrefix({ memoryIndex: null, timestamp: null, skills })
  expect(p.skillIndexText).toContain('anima:browser')
})
