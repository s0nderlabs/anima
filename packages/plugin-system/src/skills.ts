import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type ToolDef, agentPaths } from '@s0nderlabs/anima-core'
import { z } from 'zod'

/**
 * Phase 9.0 skills surface: list + view from the canonical skill paths.
 * The full Phase 9.1 skills system (Claude Code SKILL.md frontmatter parser,
 * filePattern/bashPattern auto-trigger) lands later. For now these tools
 * give the brain visibility into available skills + a way to read them.
 */

interface SkillRef {
  id: string
  name: string
  path: string
  source: 'anima' | 'claude-code'
}

interface SkillsToolDeps {
  /** Whether to scan ~/.claude/skills/ + ~/.claude/plugins/cache/ in addition to ~/.anima/skills/. */
  importsClaudeCode: boolean
  /** Override the anima skills root. Defaults to `agentPaths.skills` (respects ANIMA_ROOT). */
  animaSkillsRoot?: string
  /** Override the Claude Code skills root. Default: $HOME/.claude/skills. */
  claudeSkillsRoot?: string
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function readFrontmatterDescription(filePath: string): Promise<{
  name?: string
  description?: string
}> {
  try {
    const text = await readFile(filePath, 'utf8')
    if (!text.startsWith('---')) return {}
    const end = text.indexOf('\n---', 4)
    if (end === -1) return {}
    const block = text.slice(4, end)
    const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim()
    const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    return { name, description }
  } catch {
    return {}
  }
}

async function discoverSkills(deps: SkillsToolDeps): Promise<SkillRef[]> {
  const candidates: { dir: string; source: SkillRef['source'] }[] = [
    { dir: deps.animaSkillsRoot ?? agentPaths.skills, source: 'anima' },
  ]
  if (deps.importsClaudeCode) {
    candidates.push({
      dir: deps.claudeSkillsRoot ?? join(homedir(), '.claude', 'skills'),
      source: 'claude-code',
    })
  }
  const found: SkillRef[] = []
  for (const { dir, source } of candidates) {
    if (!(await fileExists(dir))) continue
    let entries: Dirent[] | undefined
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
    } catch {
      continue
    }
    if (!entries) continue
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = join(dir, entry.name, 'SKILL.md')
      if (!(await fileExists(skillPath))) continue
      const fm = await readFrontmatterDescription(skillPath)
      found.push({
        id: `${source}:${entry.name}`,
        name: fm.name ?? entry.name,
        path: skillPath,
        source,
      })
    }
  }
  return found
}

const ListSchema = z.object({
  source: z.enum(['anima', 'claude-code', 'all']).optional(),
})

export function makeSkillsList(deps: SkillsToolDeps): ToolDef<z.infer<typeof ListSchema>> {
  return {
    name: 'skills.list',
    description:
      'List skills available under ~/.anima/skills/ and (when imports.claudeCode is true) ~/.claude/skills/. Returns id, name, path, source. Use skills.view to read the body.',
    searchHint: 'skills list catalog discover available',
    schema: ListSchema,
    handler: async args => {
      const all = await discoverSkills(deps)
      const filter = args.source ?? 'all'
      const filtered = filter === 'all' ? all : all.filter(s => s.source === filter)
      return {
        ok: true,
        data: {
          skills: filtered.map(({ id, name, path, source }) => ({ id, name, path, source })),
        },
      }
    },
  }
}

const ViewSchema = z.object({
  id: z.string().min(1).describe('Skill id from skills.list (e.g., "anima:dogfood").'),
  max_bytes: z.number().int().positive().max(200_000).optional(),
})

export function makeSkillsView(deps: SkillsToolDeps): ToolDef<z.infer<typeof ViewSchema>> {
  return {
    name: 'skills.view',
    description:
      'Read the full SKILL.md body for a skill identified by `skills.list`. Use to inline a skill before applying it.',
    searchHint: 'skills view read body content',
    schema: ViewSchema,
    handler: async args => {
      const all = await discoverSkills(deps)
      const skill = all.find(s => s.id === args.id)
      if (!skill) return { ok: false, error: `unknown skill: ${args.id}` }
      try {
        const buf = await readFile(skill.path)
        const cap = args.max_bytes ?? 100_000
        const truncated = buf.byteLength > cap
        const text = buf.subarray(0, Math.min(buf.byteLength, cap)).toString('utf8')
        return {
          ok: true,
          data: {
            id: skill.id,
            path: skill.path,
            text,
            bytes: buf.byteLength,
            truncated,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  }
}
