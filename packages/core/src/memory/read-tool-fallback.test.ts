import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentPaths } from '../paths'
import { makeMemoryReadTool } from './read-tool'

describe('memory.read token-overlap fallback', () => {
  let tmpRoot: string
  const fakeAgentId = '0000000000000001'

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'memread-fallback-'))
    process.env.ANIMA_HOME = tmpRoot
    const paths = agentPaths.agent(fakeAgentId)
    mkdirSync(paths.memoryDir, { recursive: true })
    mkdirSync(join(paths.memoryDir, 'user'), { recursive: true })
    writeFileSync(
      paths.memoryIndex,
      `# Memory

- [Tool test session 2026-05-12](./user/tool-test-session.md) — Full tool verification
- [Operator profile](./user/operator-profile.md) — Operator known as elpabl0
`,
    )
    writeFileSync(
      join(paths.memoryDir, 'user/tool-test-session.md'),
      '---\nname: Tool test session\ntype: user\n---\nContent.',
    )
  })

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('paraphrased query finds entry via token-overlap', async () => {
    const tool = makeMemoryReadTool({ agentId: fakeAgentId })
    const r = await tool.handler({ name: 'tool test run' })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.data as { path: string }).path).toContain('tool-test-session')
  })

  it('unrelated query returns not-found', async () => {
    const tool = makeMemoryReadTool({ agentId: fakeAgentId })
    const r = await tool.handler({ name: 'banana cake unrelated' })
    expect(r.ok).toBe(false)
  })

  it('exact title match still works', async () => {
    const tool = makeMemoryReadTool({ agentId: fakeAgentId })
    const r = await tool.handler({ name: 'Tool test session' })
    expect(r.ok).toBe(true)
  })
})
