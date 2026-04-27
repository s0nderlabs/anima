import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverMcpServers } from './discovery'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'anima-mcp-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('discoverMcpServers', () => {
  it('reads ~/.anima/.mcp.json + ~/.claude/.mcp.json', async () => {
    const animaPath = join(scratch, 'anima.mcp.json')
    const claudePath = join(scratch, 'claude.mcp.json')
    await writeFile(
      animaPath,
      JSON.stringify({
        mcpServers: {
          alpha: { command: 'bun', args: ['run', 'a.ts'] },
        },
      }),
    )
    await writeFile(
      claudePath,
      JSON.stringify({
        mcpServers: {
          beta: { type: 'http', url: 'https://example.com/mcp', headers: { 'X-Foo': '1' } },
        },
      }),
    )
    const out = await discoverMcpServers({
      animaMcpPath: animaPath,
      claudeMcpPath: claudePath,
      claudePluginsCacheRoot: join(scratch, 'doesnotexist'),
      importsClaudeCode: true,
    })
    expect(out.servers).toHaveLength(2)
    const alpha = out.servers.find(s => s.name === 'alpha')
    expect(alpha?.type).toBe('stdio')
    if (alpha?.type === 'stdio') {
      expect(alpha.command).toBe('bun')
      expect(alpha.args).toEqual(['run', 'a.ts'])
    }
    const beta = out.servers.find(s => s.name === 'beta')
    expect(beta?.type).toBe('http')
    if (beta?.type === 'http') expect(beta.url).toBe('https://example.com/mcp')
  })

  it('substitutes ${CLAUDE_PLUGIN_ROOT} from plugin cache layout', async () => {
    const cacheRoot = join(scratch, 'cache')
    const versionDir = join(cacheRoot, 'mp', 'plug', '1.0.0')
    await mkdir(versionDir, { recursive: true })
    await writeFile(
      join(versionDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          plug: {
            command: 'bun',
            args: ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}', 'start'],
            env: { PLUG_ROOT: '${CLAUDE_PLUGIN_ROOT}/data' },
          },
        },
      }),
    )
    const out = await discoverMcpServers({
      animaMcpPath: join(scratch, 'doesnotexist'),
      claudeMcpPath: join(scratch, 'doesnotexist'),
      claudePluginsCacheRoot: cacheRoot,
      importsClaudeCode: true,
    })
    expect(out.servers).toHaveLength(1)
    const s = out.servers[0]!
    expect(s.type).toBe('stdio')
    if (s.type === 'stdio') {
      expect(s.args).toEqual(['run', '--cwd', versionDir, 'start'])
      expect(s.env?.PLUG_ROOT).toBe(`${versionDir}/data`)
    }
  })

  it('honors importsClaudeCode=false (only anima path scanned)', async () => {
    const claudePath = join(scratch, 'claude.mcp.json')
    await writeFile(claudePath, JSON.stringify({ mcpServers: { foo: { command: 'bun' } } }))
    const out = await discoverMcpServers({
      animaMcpPath: join(scratch, 'doesnotexist'),
      claudeMcpPath: claudePath,
      claudePluginsCacheRoot: join(scratch, 'doesnotexist'),
      importsClaudeCode: false,
    })
    expect(out.servers).toEqual([])
  })
})
