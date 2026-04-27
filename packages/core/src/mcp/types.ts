/**
 * MCP server config shape (compatible with Claude Code's `.mcp.json`).
 *
 * stdio: `{ command, args?, env? }`. anima spawns a subprocess and speaks
 * JSON-RPC over its stdin/stdout.
 *
 * http: `{ type: 'http', url, headers? }`. anima posts JSON-RPC to the URL.
 * Phase 9.2 ships stdio only; HTTP lands in 9.4 polish.
 */

export interface McpServerStdio {
  /** Server name used as the prefix in tool ids (`mcp.<name>.<tool>`). */
  name: string
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Replacement value for `${CLAUDE_PLUGIN_ROOT}` in args. Set when scanning a plugin cache. */
  pluginRoot?: string
}

export interface McpServerHttp {
  name: string
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = McpServerStdio | McpServerHttp

export interface McpToolMeta {
  /** server name */
  server: string
  /** original (unprefixed) tool name advertised by the MCP server */
  toolName: string
  description: string
  inputSchema: unknown
}

export interface McpDiscoveryResult {
  servers: McpServerConfig[]
  /** Source path the server was discovered from (debug output only). */
  sources: { server: string; path: string }[]
}
