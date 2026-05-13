import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMemoryReadTool } from './read-tool'
import { makeMemorySaveTool } from './save-tool'

// v0.23.0 Bundle A regression test.
//
// Gateway daemon writes restored memory under `${TMPDIR}/anima-gateway/<id>/`
// while `agentPaths.agent(id).memoryDir` resolves to `~/.anima/agents/<id>/`.
// Before the fix, memory.read / memory.save resolved against agentPaths
// unconditionally, so files the gateway just restored to disk were invisible
// to the brain and any new save landed in the wrong tree. The `agentDir`
// override threads the gateway's true root through so both tools resolve
// against the same path the runtime is using.
describe('memory.read / memory.save honor agentDir override', () => {
  let tmpAgentDir: string
  const fakeAgentId = '0000000000000001'

  beforeAll(() => {
    tmpAgentDir = mkdtempSync(join(tmpdir(), 'memdrift-'))
    mkdirSync(join(tmpAgentDir, 'memory', 'agent'), { recursive: true })
    mkdirSync(join(tmpAgentDir, 'memory', 'user'), { recursive: true })
    writeFileSync(
      join(tmpAgentDir, 'memory', 'MEMORY.md'),
      '# Memory\n\n- [identity](./agent/identity.md) seed\n',
    )
    writeFileSync(
      join(tmpAgentDir, 'memory', 'agent', 'identity.md'),
      '---\nname: identity\ntype: agent-identity\n---\nseeded from override path',
    )
  })

  afterAll(() => {
    if (tmpAgentDir) rmSync(tmpAgentDir, { recursive: true, force: true })
  })

  it('memory.read resolves against agentDir, not agentPaths', async () => {
    const tool = makeMemoryReadTool({ agentId: fakeAgentId, agentDir: tmpAgentDir })
    const r = await tool.handler({ name: 'identity' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const data = r.data as { path: string; content: string }
      expect(data.path).toBe('agent/identity.md')
      expect(data.content).toContain('seeded from override path')
    }
  })

  it('memory.save lands the file under agentDir', async () => {
    const tool = makeMemorySaveTool({ agentId: fakeAgentId, agentDir: tmpAgentDir })
    const r = await tool.handler({
      name: 'override save test',
      description: 'Test that save honors agentDir parameter',
      type: 'user',
      content: 'body content',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const data = r.data as { file: string }
      expect(data.file).toBe('user/override-save-test.md')
    }
    const written = readFileSync(
      join(tmpAgentDir, 'memory', 'user', 'override-save-test.md'),
      'utf8',
    )
    expect(written).toContain('body content')
    const index = readFileSync(join(tmpAgentDir, 'memory', 'MEMORY.md'), 'utf8')
    expect(index).toContain('user/override-save-test.md')
  })
})
