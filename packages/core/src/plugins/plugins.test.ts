import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { ToolRegistry } from '../tools/registry'
import type { ToolDef } from '../tools/types'
import { type NativePlugin, loadPlugins } from './context'
import { HookBus, type PreToolCallContext, type PreToolCallResult } from './hooks'
import { makeToolSearchTool } from './tool-search'

describe('ToolRegistry deferred-tool semantics', () => {
  function makeTools() {
    const r = new ToolRegistry()
    r.register({
      name: 'fs.read',
      description: 'read a file',
      schema: z.object({ path: z.string() }),
      handler: () => ({ ok: true }),
    })
    r.register({
      name: 'browser.navigate',
      description: 'navigate the browser to a URL',
      shouldDefer: true,
      searchHint: 'browser web automation page',
      schema: z.object({ url: z.string() }),
      handler: () => ({ ok: true }),
    })
    return r
  }

  it('eager tools appear in schemas; deferred tools do not until unlocked', () => {
    const r = makeTools()
    const before = r.schemas().map(s => s.function.name)
    expect(before).toContain('fs.read')
    expect(before).not.toContain('browser.navigate')
    r.unlock('browser.navigate')
    const after = r.schemas().map(s => s.function.name)
    expect(after).toContain('browser.navigate')
  })

  it('search by select:name returns exact tools', () => {
    const r = makeTools()
    const matches = r.search('select:fs.read,browser.navigate')
    expect(matches.map(t => t.name).sort()).toEqual(['browser.navigate', 'fs.read'])
  })

  it('keyword search matches deferred tools via searchHint', () => {
    const r = makeTools()
    const matches = r.search('browser web')
    expect(matches.map(t => t.name)).toContain('browser.navigate')
  })

  it('config glob deny propagates through schemas + dispatch', async () => {
    const r = new ToolRegistry({ 'fs.*': false })
    r.register({
      name: 'fs.read',
      description: 'x',
      schema: z.object({}),
      handler: () => ({ ok: true }),
    })
    expect(r.schemas()).toEqual([])
    const out = await r.dispatch({ id: '1', name: 'fs.read', args: {} })
    expect(out.ok).toBe(false)
  })
})

describe('HookBus', () => {
  it('runs pre_tool_call handlers in order, supports rewrite + short-circuit', async () => {
    const bus = new HookBus()
    bus.add<PreToolCallContext, PreToolCallResult>('pre_tool_call', ({ call }) => ({
      call: { ...call, args: { mutated: true } },
    }))
    bus.add<PreToolCallContext, PreToolCallResult>('pre_tool_call', () => ({
      short: { ok: false, error: 'denied' },
    }))
    const out = await bus.runPreToolCall({
      call: { id: '1', name: 't', args: {} },
    })
    expect(out.short).toEqual({ ok: false, error: 'denied' })
    expect(out.call?.args).toEqual({ mutated: true })
  })

  it('post_tool_call observers cannot break the loop', async () => {
    const bus = new HookBus()
    bus.add('post_tool_call', () => {
      throw new Error('boom')
    })
    let observed = false
    bus.add('post_tool_call', () => {
      observed = true
    })
    await bus.runPostToolCall({
      call: { id: '1', name: 't', args: {} },
      result: { ok: true },
    })
    expect(observed).toBe(true)
  })
})

describe('loadPlugins', () => {
  it('discovers + invokes register(ctx) per plugin', async () => {
    const r = new ToolRegistry()
    const bus = new HookBus()
    let listenerCount = 0
    const plugin: NativePlugin = {
      name: 'fake',
      register: ctx => {
        ctx.registerTool({
          name: 'fake.tool',
          description: 'x',
          schema: z.object({}),
          handler: () => ({ ok: true }),
        })
        ctx.addHook('pre_tool_call', () => undefined)
      },
    }
    const result = await loadPlugins(['fake'], {
      tools: r,
      hooks: bus,
      listeners: { register: () => listenerCount++ },
      agentDir: '/tmp/agent',
      agentId: 'agent-x',
      network: '0g-mainnet',
      configPath: '/tmp/agent/config.ts',
      imports: { claudeCode: false },
      skillsDisabled: { current: [] },
      activityLogPath: '/tmp/agent/activity.jsonl',
      workspaceRoot: '/tmp/agent',
      resolve: async () => ({ default: plugin }),
    })
    expect(result.loaded).toEqual(['fake'])
    expect(result.errors).toEqual([])
    expect(r.find('fake.tool')).toBeDefined()
  })

  it('reports errors without throwing', async () => {
    const r = new ToolRegistry()
    const bus = new HookBus()
    const result = await loadPlugins(['broken'], {
      tools: r,
      hooks: bus,
      listeners: { register: () => {} },
      agentDir: '/tmp/agent',
      agentId: 'agent-x',
      network: '0g-mainnet',
      configPath: '/tmp/agent/config.ts',
      imports: { claudeCode: false },
      skillsDisabled: { current: [] },
      activityLogPath: '/tmp/agent/activity.jsonl',
      workspaceRoot: '/tmp/agent',
      resolve: async () => {
        throw new Error('module not found')
      },
    })
    expect(result.loaded).toEqual([])
    expect(result.errors[0]?.error).toContain('module not found')
  })
})

describe('makeToolSearchTool', () => {
  it('select query unlocks deferred tools', async () => {
    const r = new ToolRegistry()
    r.register({
      name: 'fs.write',
      description: 'write a file',
      shouldDefer: true,
      searchHint: 'filesystem write text file',
      schema: z.object({ path: z.string(), text: z.string() }),
      handler: () => ({ ok: true }),
    })
    const meta = makeToolSearchTool(r)
    r.register(meta as ToolDef)
    expect(r.schemas().map(s => s.function.name)).toContain('tool.search')
    expect(r.schemas().map(s => s.function.name)).not.toContain('fs.write')
    const result = await meta.handler({ query: 'select:fs.write' })
    expect(result.ok).toBe(true)
    expect(r.schemas().map(s => s.function.name)).toContain('fs.write')
    const data = result.data as { tools: Array<{ name: string }> }
    expect(data.tools.map(t => t.name)).toEqual(['fs.write'])
  })

  it('keyword query matches by description and hint', async () => {
    const r = new ToolRegistry()
    r.register({
      name: 'browser.navigate',
      description: 'navigate the browser',
      shouldDefer: true,
      searchHint: 'browser web automation',
      schema: z.object({ url: z.string() }),
      handler: () => ({ ok: true }),
    })
    const meta = makeToolSearchTool(r)
    r.register(meta as ToolDef)
    const result = await meta.handler({ query: 'browser web' })
    const data = result.data as { matched: number }
    expect(data.matched).toBe(1)
  })
})
