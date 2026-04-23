import type { ToolCall, ToolDef, ToolResult, ToolSchema } from './types'
import { zodToJsonSchema } from './zod-schema'

interface EnablementRule {
  pattern: string
  regex: RegExp | null
  enabled: boolean
}

/**
 * Symbol-based tool registry. Tools self-register at import time (plugins
 * contribute by importing their entry module, which triggers the registry
 * call). Glob-style enable/disable via `config.tools` is applied at `list()`.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>()
  private readonly rules: EnablementRule[]

  constructor(enabled: Record<string, boolean> = {}) {
    this.rules = Object.entries(enabled).map(([pattern, on]) => ({
      pattern,
      regex: pattern.includes('*') ? new RegExp(`^${pattern.replace(/\*/g, '.*')}$`) : null,
      enabled: on,
    }))
  }

  register(def: ToolDef): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`)
    }
    this.tools.set(def.name, def as ToolDef<unknown>)
  }

  find(name: string): ToolDef | undefined {
    const tool = this.tools.get(name)
    if (!tool) return undefined
    if (!this.isEnabled(name)) return undefined
    return tool
  }

  list(): ToolDef[] {
    return [...this.tools.values()].filter(t => this.isEnabled(t.name))
  }

  /** OpenAI-format schemas, ready to send to 0G Compute. */
  schemas(): ToolSchema[] {
    return this.list().map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.schema),
      },
    }))
  }

  async dispatch(call: ToolCall): Promise<ToolResult> {
    const tool = this.find(call.name)
    if (!tool) return { ok: false, error: `Unknown tool: ${call.name}` }
    const parsed = tool.schema.safeParse(call.args)
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` }
    }
    try {
      return await tool.handler(parsed.data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: msg }
    }
  }

  private isEnabled(name: string): boolean {
    // Right-most matching rule wins. No explicit rule = enabled by default.
    let decision: boolean | null = null
    for (const rule of this.rules) {
      const matches = rule.regex ? rule.regex.test(name) : rule.pattern === name
      if (matches) decision = rule.enabled
    }
    return decision ?? true
  }
}
