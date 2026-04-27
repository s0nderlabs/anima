import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '../tools/registry'
import type { ToolDef } from '../tools/types'
import { McpManager } from './manager'

let scratch: string
let serverPath: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'anima-mcp-server-'))
  serverPath = join(scratch, 'server.ts')
  // Minimal stdio MCP server: handles initialize, tools/list, tools/call.
  await writeFile(
    serverPath,
    `process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', chunk => {
  buf += chunk
  let nl = buf.indexOf('\\n')
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    nl = buf.indexOf('\\n')
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } },
      }) + '\\n')
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { tools: [{ name: 'echo', description: 'echoes input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] },
      }) + '\\n')
    } else if (msg.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: msg.params.arguments.text }] },
      }) + '\\n')
    }
  }
})
`,
  )
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('McpManager', () => {
  it('spawns stdio server, registers tool, dispatches via registry', async () => {
    const mgr = new McpManager([
      { name: 'fake', type: 'stdio', command: 'bun', args: ['run', serverPath] },
    ])
    const reg = new ToolRegistry()
    const result = await mgr.registerAll(def => reg.register(def))
    expect(result.registered).toBe(1)
    expect(result.failed).toEqual([])

    const tool = reg.find('mcp.fake.echo') as ToolDef
    expect(tool).toBeDefined()
    expect(tool.shouldDefer).toBe(true)
    expect(tool.parametersOverride?.properties).toEqual({ text: { type: 'string' } })

    const out = await reg.dispatch({ id: '1', name: 'mcp.fake.echo', args: { text: 'hi' } })
    expect(out.ok).toBe(true)
    expect(out.data).toMatchObject({ content: [{ type: 'text', text: 'hi' }] })

    mgr.closeAll()
  })

  it('reports failed servers without throwing', async () => {
    const mgr = new McpManager([{ name: 'broken', type: 'stdio', command: '/does/not/exist' }])
    const reg = new ToolRegistry()
    const result = await mgr.registerAll(def => reg.register(def))
    expect(result.registered).toBe(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.server).toBe('broken')
    mgr.closeAll()
  })

  it('flags http servers as not yet supported', async () => {
    const mgr = new McpManager([
      { name: 'http-thing', type: 'http', url: 'https://example.com/mcp' },
    ])
    const reg = new ToolRegistry()
    const result = await mgr.registerAll(def => reg.register(def))
    expect(result.registered).toBe(0)
    expect(result.failed[0]!.error).toContain('http MCP')
    mgr.closeAll()
  })
})
