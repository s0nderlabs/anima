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
