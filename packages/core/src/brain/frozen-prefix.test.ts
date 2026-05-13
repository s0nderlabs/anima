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

test('default system prompt includes browser guidance always-on (not conditional)', () => {
  const p = buildFrozenPrefix({ memoryIndex: null, timestamp: null })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('browser.navigate')
  expect(rendered).toContain('headless Chromium')
  expect(rendered).toContain('agent-browser')
})

test('default system prompt forbids pre-flight environment probes for browser', () => {
  // v0.19.18 regression guard: brain was hitting `shell.run "which chromium ..."`
  // before browser.navigate, blocking forever on the resulting approval and
  // then hallucinating "browser tools aren't available in this sandbox" when
  // the probe was denied. The guidance must explicitly forbid those probes.
  const p = buildFrozenPrefix({ memoryIndex: null, timestamp: null })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('Do NOT pre-probe the environment')
  expect(rendered).toContain('which chromium')
  expect(rendered).toContain('self-contained')
})

test('default system prompt includes tool-use enforcement', () => {
  const p = buildFrozenPrefix({ memoryIndex: null, timestamp: null })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('You MUST use your tools')
  expect(rendered).toContain('NEVER answer these from memory')
})

test('buildFrozenPrefix appends operator promptAppend under # Operator instructions', () => {
  const p = buildFrozenPrefix({
    memoryIndex: null,
    timestamp: null,
    promptAppend: 'Always reply in Indonesian.',
  })
  expect(p.appendText).toBe('Always reply in Indonesian.')
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('# Operator instructions')
  expect(rendered).toContain('Always reply in Indonesian.')
})

test('buildFrozenPrefix renders envInfo cwd + platform', () => {
  const p = buildFrozenPrefix({
    memoryIndex: null,
    timestamp: null,
    envInfo: { cwd: '/tmp/x', platform: 'darwin' },
  })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('# Environment')
  expect(rendered).toContain('cwd: /tmp/x')
  expect(rendered).toContain('platform: darwin')
})

test('envInfo with sandbox=docker surfaces inner OS + workspace mount + scope', () => {
  const p = buildFrozenPrefix({
    memoryIndex: null,
    timestamp: null,
    envInfo: {
      cwd: '/tmp/x',
      platform: 'darwin',
      sandbox: {
        mode: 'docker',
        label: 'podman:nikolaik/python-nodejs:python3.11-nodejs20+workspace',
        innerOs: 'linux',
        workspaceMount: '/workspace',
        scope: 'shell.run, code.execute, shell.process_start run inside the container',
      },
    },
  })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('sandbox: docker (podman:')
  expect(rendered).toContain('inner os: linux')
  expect(rendered).toContain('workspace mount: host cwd is bind-mounted at /workspace')
  expect(rendered).toContain('scope: shell.run, code.execute')
})

test('envInfo with sandbox.mode=none does NOT add the sandbox section', () => {
  const p = buildFrozenPrefix({
    memoryIndex: null,
    timestamp: null,
    envInfo: {
      cwd: '/tmp/x',
      platform: 'darwin',
      sandbox: { mode: 'none', label: 'none' },
    },
  })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('cwd: /tmp/x')
  expect(rendered).not.toContain('sandbox:')
})

test('envInfo with sandbox=os surfaces label + scope under # Environment', () => {
  const p = buildFrozenPrefix({
    memoryIndex: null,
    timestamp: null,
    envInfo: {
      cwd: '/tmp/x',
      platform: 'darwin',
      sandbox: {
        mode: 'os',
        label: 'os:darwin',
        innerOs: 'darwin',
        workspaceMount: null,
        scope: 'spawns wrapped in sandbox-exec; writes outside agentDir + cwd denied',
      },
    },
  })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toContain('sandbox: os (os:darwin)')
  expect(rendered).toContain('scope: spawns wrapped in sandbox-exec')
  expect(rendered).not.toContain('workspace mount:')
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

// v0.22.0: brain emitted em-dashes in prose + table separators, violating the
// project hard rule (global CLAUDE.md). The system prompt now carries an
// explicit ASCII-hyphen rule in the Tone and style section.
test('system prompt instructs brain to use ASCII hyphens, not em-dashes', () => {
  const p = buildFrozenPrefix({ memoryIndex: null, timestamp: null })
  const rendered = renderFrozenPrefix(p)
  expect(rendered).toMatch(/ASCII hyphens/)
  expect(rendered).toMatch(/em-dashes/)
  // Reference U+2014 explicitly so the brain knows the exact codepoint
  expect(rendered).toMatch(/U\+2014/)
})
