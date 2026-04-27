/**
 * Phase 9.1 skills surface. Mirrors Claude Code's SKILL.md frontmatter so
 * imports.claudeCode picks up the entire ~/.claude ecosystem free.
 */
export type SkillSource = 'anima' | 'anima-plugin' | 'claude-code' | 'claude-plugin'

export interface SkillFrontmatter {
  /** Unique name used by the brain to reference this skill. Required. */
  name: string
  /** One-line summary the brain sees in the skill index. Required. */
  description: string
  version?: string
  license?: string
  /** Comma-separated globs (e.g. `*.test.ts,*.spec.ts`) that auto-trigger the skill on fs.* paths. */
  filePattern?: string
  /** Regex (string) that auto-triggers the skill on shell.run commands. */
  bashPattern?: string
  /**
   * Claude Code commands set this to distinguish slash-only invocations from
   * model-invokable skills. Skills omit it; commands set it (any value).
   */
  argumentHint?: string
}

export interface SkillRef {
  /** `<source-prefix>:<dir-name>` (e.g. `anima:dogfood`, `claude-code:tmux`). */
  id: string
  /** Display name from frontmatter (falls back to directory name). */
  name: string
  description: string
  /** Absolute path to SKILL.md. */
  path: string
  source: SkillSource
  /** When set, marketplace > plugin > version triple from `~/.claude/plugins/cache/...` paths. */
  pluginCoord?: { marketplace: string; plugin: string; version: string }
  frontmatter: SkillFrontmatter
}
