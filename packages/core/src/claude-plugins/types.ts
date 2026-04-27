/**
 * Phase 9.2 Bundle 8 surfaces: Claude Code commands + agents discovered from
 * the local plugin cache. Both are markdown files with YAML frontmatter; the
 * body is the prompt that anima inlines when the command/agent fires.
 */

export interface ClaudeCommand {
  /** `<plugin>:<name>` (anima drops the marketplace prefix; the cmd surface is flat). */
  id: string
  /** Bare command name (e.g. `setup`, `mode`, `commit`). */
  name: string
  description: string
  /** Optional argument-hint shown after the slash command in help. */
  argumentHint?: string
  /** Absolute path to the markdown file. */
  path: string
  /** Body without frontmatter; this is the prompt template anima inlines. */
  body: string
  /** Source plugin coordinates (marketplace, plugin, version). */
  source: { marketplace: string; plugin: string; version: string }
}

export interface ClaudeAgent {
  /** `<plugin>:<name>` */
  id: string
  name: string
  description: string
  /** Optional model hint from frontmatter (e.g. `sonnet`). anima ignores it (uses configured brain). */
  model?: string
  path: string
  body: string
  source: { marketplace: string; plugin: string; version: string }
}

export interface ClaudeExtrasDiscoveryResult {
  commands: ClaudeCommand[]
  agents: ClaudeAgent[]
}
