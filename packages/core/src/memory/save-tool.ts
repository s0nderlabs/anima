import { z } from 'zod'
import { agentPaths } from '../paths'
import type { ToolDef } from '../tools/types'
import { addEntryLine, readIndexFile, writeIndexFile } from './index-file'
import { scanForThreats } from './scan'
import { readTopic, writeTopic } from './topic'
import {
  MEMORY_TYPES,
  type MemoryFrontmatter,
  type MemoryPartition,
  type MemoryTopic,
  type MemoryType,
} from './types'

const saveSchema = z.object({
  name: z.string().min(3).max(64).describe('Short human-readable title for this memory.'),
  description: z
    .string()
    .min(10)
    .max(240)
    .describe('One-line description used to decide relevance in future sessions. Be specific.'),
  type: z
    .enum(MEMORY_TYPES)
    .describe(
      'Memory type. agent-* transfers with iNFT; user/feedback/project/reference are operator-scoped and purge on transfer.',
    ),
  /** For MVP we only support full-body rewrite. Edit ops follow in phase 3.5+. */
  content: z
    .string()
    .min(1)
    .max(10_000)
    .describe('Full markdown body of the memory (no frontmatter — it gets added).'),
})

export type MemorySaveArgs = z.infer<typeof saveSchema>

export interface MakeMemorySaveToolArgs {
  agentId: string
}

export function makeMemorySaveTool({ agentId }: MakeMemorySaveToolArgs): ToolDef<MemorySaveArgs> {
  return {
    name: 'memory.save',
    description:
      'Save a durable fact, preference, or knowledge to long-term memory. Call proactively when you learn non-obvious things about the user or world. Skip derivable info (code patterns, git log, ephemeral state).',
    schema: saveSchema,
    handler: async args => {
      const scan = scanForThreats(args.content)
      if (!scan.ok) {
        return {
          ok: false,
          error: `Content rejected by threat scan: ${scan.violations.map(v => v.id).join(', ')}`,
        }
      }

      const partition = partitionForType(args.type)
      const slug = toSlug(args.name, args.type)
      const dir = agentPaths.agent(agentId).dir
      const now = new Date().toISOString()

      const existing = await readTopic(dir, partition, slug)
      const fm: MemoryFrontmatter = {
        name: args.name,
        description: args.description,
        type: args.type,
        createdAt: existing?.frontmatter.createdAt ?? now,
        updatedAt: now,
      }
      const topic: MemoryTopic = {
        partition,
        slug,
        frontmatter: fm,
        body: existing ? appendBody(existing.body, args.content) : args.content,
      }
      await writeTopic(dir, topic)

      const indexPath = agentPaths.agent(agentId).memoryIndex
      let index = await readIndexFile(indexPath)
      const file = `${partition}/${slug}.md`
      if (!index.entries.has(file)) {
        index = addEntryLine(index, {
          file,
          title: args.name,
          hook: args.description,
        })
        await writeIndexFile(indexPath, index)
      }

      return {
        ok: true,
        data: { file, partition, slug, updated: existing !== null },
      }
    },
  }
}

function partitionForType(type: MemoryType): MemoryPartition {
  return type.startsWith('agent-') ? 'agent' : 'user'
}

function toSlug(name: string, type: MemoryType): string {
  const prefix = type.startsWith('user-')
    ? type.replace(/^user-/, '')
    : type.startsWith('agent-')
      ? type.replace(/^agent-/, '')
      : type
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  return `${prefix}-${base}`
}

function appendBody(prev: string, add: string): string {
  const trimmed = prev.trimEnd()
  return `${trimmed}\n\n${add}`
}
