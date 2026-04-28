import { z } from 'zod'
import type { ToolRegistry } from '../tools/registry'
import type { ToolDef } from '../tools/types'
import { coerceInt } from '../tools/zod-helpers'
import { zodToJsonSchema } from '../tools/zod-schema'

const ToolSearchSchema = z.object({
  query: z.string().min(1, 'query is required'),
  max_results: coerceInt.refine(n => n > 0 && n <= 20, 'max_results must be 1..20').optional(),
})

export type ToolSearchArgs = z.infer<typeof ToolSearchSchema>

/**
 * `tool.search` meta-tool: brain calls this to hydrate deferred tool
 * schemas. Mirrors Claude Code's ToolSearch surface, accepts either an
 * explicit `select:foo,bar` query or a free-text keyword query.
 */
export function makeToolSearchTool(registry: ToolRegistry): ToolDef<ToolSearchArgs> {
  return {
    name: 'tool.search',
    description:
      'Look up deferred tool schemas. Use `select:name1,name2` to fetch by name, or free-text keywords (e.g., "filesystem read") to search descriptions and hints. Returns matching tools with their full parameter schema; the brain can immediately call them next turn.',
    alwaysLoad: true,
    searchHint: 'meta search deferred tools schemas',
    schema: ToolSearchSchema,
    handler: args => {
      const max = args.max_results ?? 5
      const matches = registry.search(args.query, max)
      const schemas = matches.map(t => {
        registry.unlock(t.name)
        return {
          name: t.name,
          description: t.description,
          parameters: t.parametersOverride ?? zodToJsonSchema(t.schema),
          searchHint: t.searchHint,
        }
      })
      return {
        ok: true,
        data: {
          query: args.query,
          matched: schemas.length,
          tools: schemas,
        },
      }
    },
  }
}
