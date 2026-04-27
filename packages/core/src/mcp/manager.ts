import { z } from 'zod'
import type { JSONSchema, ToolDef } from '../tools/types'
import { McpStdioClient } from './stdio-client'
import type { McpServerConfig, McpToolMeta } from './types'

/**
 * Lifecycle manager for one or more MCP servers. Spawns each subprocess at
 * registration time, calls `tools/list`, and registers each remote tool as
 * `mcp.<server>.<tool>` with `shouldDefer: true` so the brain only sees the
 * full schema after `tool.search`.
 *
 * Lifecycle: caller invokes `closeAll()` on session end (chat exit).
 */
export class McpManager {
  private readonly clients = new Map<string, McpStdioClient>()
  private readonly toolMeta = new Map<string, McpToolMeta>()

  constructor(public readonly servers: readonly McpServerConfig[]) {}

  async registerAll(register: (def: ToolDef) => void): Promise<{
    registered: number
    failed: { server: string; error: string }[]
  }> {
    const failed: { server: string; error: string }[] = []
    let registered = 0
    await Promise.all(
      this.servers.map(async server => {
        if (server.type === 'http') {
          failed.push({ server: server.name, error: 'http MCP not yet supported (Phase 9.4)' })
          return
        }
        try {
          const client = new McpStdioClient(server)
          this.clients.set(server.name, client)
          const tools = await client.listTools()
          for (const t of tools) {
            const id = `mcp.${server.name}.${t.name}`
            const meta: McpToolMeta = {
              server: server.name,
              toolName: t.name,
              description: t.description ?? '',
              inputSchema: t.inputSchema ?? defaultSchema(),
            }
            this.toolMeta.set(id, meta)
            register(this.makeToolDef(id, meta))
            registered++
          }
        } catch (e) {
          failed.push({ server: server.name, error: (e as Error).message })
          const dead = this.clients.get(server.name)
          dead?.close()
          this.clients.delete(server.name)
        }
      }),
    )
    return { registered, failed }
  }

  closeAll(): void {
    for (const client of this.clients.values()) client.close()
    this.clients.clear()
  }

  private makeToolDef(id: string, meta: McpToolMeta): ToolDef {
    const head = meta.description ? `${meta.description.trim()}\n\n` : ''
    const description = `${head}(MCP tool from server '${meta.server}', mapped to '${meta.toolName}'.)`
    return {
      name: id,
      description,
      shouldDefer: true,
      searchHint: `mcp ${meta.server} ${meta.toolName}`,
      schema: z.unknown(),
      parametersOverride: toJsonSchemaShape(meta.inputSchema),
      handler: async args => {
        const client = this.clients.get(meta.server)
        if (!client) {
          return { ok: false, error: `mcp server '${meta.server}' not running` }
        }
        try {
          const result = await client.callTool(meta.toolName, args ?? {})
          return { ok: true, data: result }
        } catch (e) {
          return { ok: false, error: (e as Error).message }
        }
      },
    }
  }
}

function defaultSchema(): JSONSchema {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  }
}

function toJsonSchemaShape(raw: unknown): JSONSchema {
  if (!raw || typeof raw !== 'object') return defaultSchema()
  const r = raw as Record<string, unknown>
  if (r.type !== 'object' && !('properties' in r)) return defaultSchema()
  return {
    type: 'object',
    properties: (r.properties as Record<string, unknown>) ?? {},
    required: Array.isArray(r.required) ? (r.required as string[]) : undefined,
    additionalProperties:
      typeof r.additionalProperties === 'boolean' ? (r.additionalProperties as boolean) : true,
    description: typeof r.description === 'string' ? (r.description as string) : undefined,
  }
}
