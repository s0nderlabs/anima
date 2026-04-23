import { expect, test } from 'bun:test'
import { buildFrozenPrefix, renderFrozenPrefix } from './frozen-prefix'

test('buildFrozenPrefix without memory index returns system prompt only', () => {
  const p = buildFrozenPrefix({ memoryIndex: null })
  expect(p.memoryIndexText).toBeNull()
  expect(p.systemPrompt.length).toBeGreaterThan(0)
  expect(renderFrozenPrefix(p)).toBe(p.systemPrompt)
})

test('buildFrozenPrefix with memory index embeds it in prefix', () => {
  const memoryIndex = {
    lines: ['# agent-id — Memory Index', '', '## Memories', '', '- [foo](agent/foo.md) — hello'],
    entries: new Map(),
  }
  const p = buildFrozenPrefix({ memoryIndex })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('MEMORY.md (index')
  expect(rendered).toContain('foo')
})

test('buildFrozenPrefix accepts custom system prompt', () => {
  const p = buildFrozenPrefix({ systemPrompt: 'custom.', memoryIndex: null })
  expect(renderFrozenPrefix(p)).toBe('custom.')
})
