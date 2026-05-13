import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { bootstrapHashFor } from '../identity/contract'
import { INTELLIGENT_DATA_SLOTS, type IntelligentDataEntry } from '../identity/intelligent-data'
import { makeMemoryListTool } from './list-tool'

describe('memory.list tool', () => {
  let tmpAgentDir: string
  const fakeAgentId = '0000000000000001'
  const fakeContract = '0x9e71d79f06f956d4d2666b5c93dafab721c84721' as const
  const fakeTokenId = 6n

  beforeAll(() => {
    tmpAgentDir = mkdtempSync(join(tmpdir(), 'memlist-'))
    mkdirSync(join(tmpAgentDir, 'memory', 'agent'), { recursive: true })
    mkdirSync(join(tmpAgentDir, 'memory', 'user'), { recursive: true })
    writeFileSync(
      join(tmpAgentDir, 'memory', 'agent', 'identity.md'),
      '---\nname: identity\ndescription: Auto-written agent identity facts\ntype: agent-identity\n---\n# identity\n\nbody',
    )
    writeFileSync(
      join(tmpAgentDir, 'memory', 'agent', 'persona.md'),
      '---\nname: persona\ndescription: Voice + behavior style\ntype: agent-persona\n---\nstyle prose',
    )
    writeFileSync(
      join(tmpAgentDir, 'memory', 'user', 'feedback-darkmode.md'),
      '---\nname: prefers dark mode\ndescription: Operator prefers dark mode\ntype: user\n---\nbody',
    )
  })

  afterAll(() => {
    if (tmpAgentDir) rmSync(tmpAgentDir, { recursive: true, force: true })
  })

  const allBootstrapSlots: IntelligentDataEntry[] = INTELLIGENT_DATA_SLOTS.map(slot => ({
    dataDescription: slot,
    dataHash: bootstrapHashFor(slot),
  }))

  it('lists agent + user partitions and 6 slots', async () => {
    const tool = makeMemoryListTool({
      agentId: fakeAgentId,
      agentDir: tmpAgentDir,
      network: '0g-mainnet',
      contractAddress: fakeContract,
      tokenId: fakeTokenId,
      fetchSlots: async () => allBootstrapSlots,
    })
    const r = await tool.handler({})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as {
      agent: Array<{ file: string; title: string; description: string | null }>
      user: Array<{ file: string }>
      slots: Array<{ slot: string; status: string }>
    }
    expect(data.agent.map(a => a.file).sort()).toEqual(['agent/identity.md', 'agent/persona.md'])
    expect(data.agent.find(a => a.file === 'agent/identity.md')?.description).toBe(
      'Auto-written agent identity facts',
    )
    expect(data.user.map(u => u.file)).toEqual(['user/feedback-darkmode.md'])
    expect(data.slots).toHaveLength(6)
    for (const s of data.slots) expect(s.status).toBe('bootstrap')
  })

  it('flags initialized slots when hash diverges from bootstrap', async () => {
    // Pick a hash that is neither zero nor the bootstrap placeholder for `identity`.
    const customSlots: IntelligentDataEntry[] = INTELLIGENT_DATA_SLOTS.map(slot => ({
      dataDescription: slot,
      dataHash:
        slot === 'identity'
          ? ('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex)
          : bootstrapHashFor(slot),
    }))
    const tool = makeMemoryListTool({
      agentId: fakeAgentId,
      agentDir: tmpAgentDir,
      network: '0g-mainnet',
      contractAddress: fakeContract,
      tokenId: fakeTokenId,
      fetchSlots: async () => customSlots,
    })
    const r = await tool.handler({})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { slots: Array<{ slot: string; status: string }> }
    const identitySlot = data.slots.find(s => s.slot === 'identity')
    expect(identitySlot?.status).toBe('initialized')
    const personaSlot = data.slots.find(s => s.slot === 'persona')
    expect(personaSlot?.status).toBe('bootstrap')
  })

  it('returns empty partitions when dirs do not exist', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'memlist-empty-'))
    try {
      const tool = makeMemoryListTool({
        agentId: fakeAgentId,
        agentDir: empty,
        network: '0g-mainnet',
        contractAddress: fakeContract,
        tokenId: fakeTokenId,
        fetchSlots: async () => allBootstrapSlots,
      })
      const r = await tool.handler({})
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const data = r.data as { agent: unknown[]; user: unknown[] }
      expect(data.agent).toEqual([])
      expect(data.user).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('falls back to filename when frontmatter lacks name+description', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memlist-nofm-'))
    try {
      mkdirSync(join(dir, 'memory', 'user'), { recursive: true })
      writeFileSync(join(dir, 'memory', 'user', 'plain.md'), 'no frontmatter body')
      const tool = makeMemoryListTool({
        agentId: fakeAgentId,
        agentDir: dir,
        network: '0g-mainnet',
        contractAddress: fakeContract,
        tokenId: fakeTokenId,
        fetchSlots: async () => allBootstrapSlots,
      })
      const r = await tool.handler({})
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const data = r.data as { user: Array<{ title: string; description: string | null }> }
      expect(data.user[0]?.title).toBe('plain')
      expect(data.user[0]?.description).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
