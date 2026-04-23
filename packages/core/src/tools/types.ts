import type { z } from 'zod'

/** OpenAI-compatible JSON Schema for a function parameter spec. */
export interface JSONSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  description?: string
}

/** Shape we hand to the brain when asking it to plan with tools. */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JSONSchema
  }
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export interface ToolDef<TArgs = unknown> {
  name: string
  description: string
  /** zod schema the runtime uses to both validate AND build JSONSchema for the brain. */
  schema: z.ZodType<TArgs>
  handler: (args: TArgs) => Promise<ToolResult> | ToolResult
}

export interface ToolResult {
  ok: boolean
  data?: unknown
  error?: string
}
