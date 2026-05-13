import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { agentPaths } from '../paths'
import type { ToolDef } from '../tools/types'
import { readIndexFile } from './index-file'

/**
 * `memory.read` — fetch a memory file's full body by title, slug, or relative
 * path. Resolution order:
 *
 *   1. If `name` is a relative path under the memory dir → read directly.
 *   2. Look up MEMORY.md: match entry whose title or filename contains the
 *      requested string (case-insensitive substring). MEMORY.md is the
 *      authoritative registry, so this catches whatever weird filename
 *      `memory.save` produced.
 *   3. Try common naming patterns as a last resort.
 *
 * Without this tool the brain only sees the index hook line and can't recall
 * specifics ("what's stored in user-favorite-color.md") on demand.
 */
const readSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'Memory entry title (from MEMORY.md), slug, or relative path. Examples: `favorite-color`, `Anima identity`, `user/user-elpabl0.md`.',
    ),
})

export type MemoryReadArgs = z.infer<typeof readSchema>

export interface MakeMemoryReadToolArgs {
  agentId: string
  /**
   * Override the on-disk agent dir. Gateway daemon writes restored memory
   * under `${TMPDIR}/anima-gateway/<id>/` while local-mode chat.tsx uses
   * `~/.anima/agents/<id>/`. Pass the daemon's true agentDir so the brain's
   * memory.read resolves against the same path the gateway just wrote to —
   * otherwise files restored from chain return "not found" because the tool
   * defaults to agentPaths (the legacy location).
   */
  agentDir?: string
}

export function makeMemoryReadTool({
  agentId,
  agentDir,
}: MakeMemoryReadToolArgs): ToolDef<MemoryReadArgs> {
  return {
    name: 'memory.read',
    description:
      'Read the full body of a memory file. Use to recall specific facts. Match by title from MEMORY.md, slug, or relative path. Tries multiple resolutions before giving up.',
    schema: readSchema,
    handler: async args => {
      const memDir = agentDir ? `${agentDir}/memory` : agentPaths.agent(agentId).memoryDir
      const memoryIndex = agentDir
        ? `${agentDir}/memory/MEMORY.md`
        : agentPaths.agent(agentId).memoryIndex
      const query = args.name.trim()
      const safeRead = makeSafeReader(memDir)

      const tried: string[] = []

      // 1. Direct relative path with .md (path-traversal-checked).
      if (query.endsWith('.md') && query.includes('/')) {
        const result = await safeRead(query)
        tried.push(query)
        if (result) return success(query, result)
      }

      // 2. MEMORY.md lookup — match by title or filename. Three passes:
      //    (a) exact match on title or file
      //    (b) substring of title or file contains the full query
      //    (c) token-overlap score (each non-stopword in query that appears
      //        in the entry's title+file+hook counts; ties broken by recency)
      // Pass (c) is the one that catches "tool test run" → "Tool test session"
      // — the brain often paraphrases titles when recalling, and substring
      // match alone fails when the operator's word order or extra tokens
      // differ from the canonical name.
      try {
        const idx = await readIndexFile(memoryIndex)
        const q = query.toLowerCase()
        const entries = Array.from(idx.entries.values())
        const exact = entries.find(e => e.title.toLowerCase() === q || e.file.toLowerCase() === q)
        const substringMatch =
          exact ??
          entries.find(e => e.title.toLowerCase().includes(q) || e.file.toLowerCase().includes(q))
        let match = substringMatch
        if (!match) {
          const STOP = new Set([
            'the',
            'a',
            'an',
            'and',
            'or',
            'of',
            'to',
            'in',
            'on',
            'for',
            'is',
            'are',
            'was',
            'were',
            'be',
            'been',
            'i',
            'my',
            'me',
            'you',
            'your',
            'about',
            'remember',
            'what',
            'did',
            'tell',
            'said',
            'told',
            'memory',
            'note',
            'notes',
          ])
          const tokens = q.split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !STOP.has(t))
          if (tokens.length > 0) {
            let best: { entry: (typeof entries)[number]; score: number } | null = null
            for (const e of entries) {
              const blob = `${e.title} ${e.file} ${e.hook ?? ''}`.toLowerCase()
              const score = tokens.reduce((s, t) => s + (blob.includes(t) ? 1 : 0), 0)
              if (score > 0 && (best === null || score > best.score)) {
                best = { entry: e, score }
              }
            }
            if (best && best.score >= Math.max(1, Math.ceil(tokens.length / 2))) {
              match = best.entry
            }
          }
        }
        if (match) {
          const result = await safeRead(match.file)
          tried.push(`MEMORY.md→${match.file}`)
          if (result) return success(match.file, result)
        }
      } catch {
        // MEMORY.md missing or unreadable — fall through to direct paths.
      }

      // 3. Common naming patterns
      const stem = query.replace(/\.md$/, '').replace(/^\/+/, '')
      const fallbacks = [
        `agent/${stem}.md`,
        `user/${stem}.md`,
        `agent/identity-${stem}.md`,
        `agent/learned-${stem}.md`,
        `user/user-${stem}.md`,
        `user/feedback-${stem}.md`,
        `user/project-${stem}.md`,
        `user/reference-${stem}.md`,
      ]
      for (const rel of fallbacks) {
        const result = await safeRead(rel)
        tried.push(rel)
        if (result) return success(rel, result)
      }

      return {
        ok: false,
        error: `Memory file not found for "${query}". Tried: ${tried.join(', ')}`,
      }
    },
  }
}

/**
 * Returns a reader that refuses to escape the agent's memory directory.
 * Prevents `../../etc/passwd.md`-style traversal even if a malicious memory
 * entry steers the brain into asking for an out-of-tree path.
 */
function makeSafeReader(memDir: string) {
  const root = resolve(memDir)
  return async (relPath: string): Promise<string | null> => {
    const full = resolve(memDir, relPath)
    if (full !== root && !full.startsWith(`${root}/`)) {
      return null
    }
    try {
      return await readFile(full, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }
}

function success(path: string, content: string) {
  return { ok: true, data: { path, content } }
}
