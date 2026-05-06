/**
 * Shared slash-command registry. The TUI autocomplete popup, TG
 * `setMyCommands` registration, and the various bypass dispatchers all read
 * from this single source so command lists never drift between surfaces.
 */

export type CommandSurface = 'tui' | 'tg'

/**
 * - `local`  : runs in the CLI process (TUI handler, local TG via chat-telegram)
 * - `gateway`: runs in the gateway process (sandbox harness or local-mode gateway daemon)
 * - `both`   : valid in either surface; routing decided by where the command arrives
 */
export type CommandScope = 'local' | 'gateway' | 'both'

export interface SlashCommand {
  /** Command name without leading slash, e.g. "yolo". Lowercased. */
  name: string
  /** One-line human description used in TUI menu + TG client menu. */
  description: string
  /** Surfaces the command should appear in for discovery. */
  surfaces: CommandSurface[]
  /** Where the command actually executes. */
  scope: CommandScope
  /** True when the command short-circuits before brain.infer (control commands). */
  bypassesBrain: boolean
  /** Optional argument hint shown next to the name in menus, e.g. "off|prompt|strict". */
  argHint?: string
}

export const COMMAND_REGISTRY: SlashCommand[] = [
  {
    name: 'yolo',
    description: 'Toggle approval prompts on/off',
    surfaces: ['tui', 'tg'],
    scope: 'both',
    bypassesBrain: true,
  },
  {
    name: 'perms',
    description: 'Set permission mode',
    surfaces: ['tui', 'tg'],
    scope: 'both',
    bypassesBrain: true,
    argHint: 'off|prompt|strict',
  },
  {
    name: 'reset',
    description: 'Clear conversation history for this channel',
    surfaces: ['tui', 'tg'],
    scope: 'both',
    bypassesBrain: true,
  },
  {
    name: 'sync',
    description: 'Force memory sync to 0G Storage',
    surfaces: ['tui'],
    scope: 'local',
    bypassesBrain: true,
  },
  {
    name: 'model',
    description: 'Show brain model switch hint',
    surfaces: ['tui'],
    scope: 'local',
    bypassesBrain: true,
  },
  {
    name: 'jobs',
    description: 'List active marketplace jobs',
    surfaces: ['tui'],
    scope: 'local',
    bypassesBrain: true,
  },
  {
    name: 'help',
    description: 'Show all commands',
    surfaces: ['tui'],
    scope: 'local',
    bypassesBrain: true,
  },
  {
    name: 'exit',
    description: 'Quit anima',
    surfaces: ['tui'],
    scope: 'local',
    bypassesBrain: true,
  },
  {
    name: 'quit',
    description: 'Quit anima',
    surfaces: ['tui'],
    scope: 'local',
    bypassesBrain: true,
  },
  {
    name: 'stop',
    description: 'Cancel current turn',
    surfaces: ['tg'],
    scope: 'gateway',
    bypassesBrain: true,
  },
  {
    name: 'new',
    description: 'Start a fresh session',
    surfaces: ['tg'],
    scope: 'gateway',
    bypassesBrain: true,
  },
  {
    name: 'status',
    description: 'Show agent status',
    surfaces: ['tg'],
    scope: 'gateway',
    bypassesBrain: true,
  },
  {
    name: 'approve',
    description: 'Approve the pending request',
    surfaces: ['tg'],
    scope: 'gateway',
    bypassesBrain: true,
  },
  {
    name: 'deny',
    description: 'Deny the pending request',
    surfaces: ['tg'],
    scope: 'gateway',
    bypassesBrain: true,
  },
  {
    name: 'background',
    description: 'Move the current turn to background',
    surfaces: ['tg'],
    scope: 'gateway',
    bypassesBrain: true,
  },
  {
    name: 'restart',
    description: 'Restart the active session',
    surfaces: ['tg'],
    scope: 'gateway',
    bypassesBrain: true,
  },
]

export function commandsForSurface(surface: CommandSurface): SlashCommand[] {
  return COMMAND_REGISTRY.filter(c => c.surfaces.includes(surface))
}

export function findCommand(name: string): SlashCommand | undefined {
  const needle = name.replace(/^\/+/, '').toLowerCase()
  return COMMAND_REGISTRY.find(c => c.name === needle)
}

export interface ParsedSlash {
  /** Raw command name lowercased, no leading slash. */
  name: string
  /** Whitespace-split argv after the command. */
  args: string[]
  /** Resolved registry entry when name matches a known command, otherwise undefined. */
  command?: SlashCommand
}

/**
 * Parse a leading-slash message into name + args. Returns null when the input
 * doesn't start with a slash. Unknown command names still return a parsed
 * shape (with `command` undefined) so callers can distinguish "not a slash"
 * from "slash but unknown".
 */
export function parseSlash(text: string): ParsedSlash | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  const stripped = trimmed.slice(1).trimEnd()
  if (stripped.length === 0) return null
  const parts = stripped.split(/\s+/)
  const name = (parts[0] ?? '').toLowerCase()
  if (name.length === 0) return null
  const args = parts.slice(1)
  return { name, args, command: findCommand(name) }
}

/**
 * Filter commands by surface and prefix for autocomplete suggestions.
 * Empty or single-`/` query returns all commands for the surface.
 */
export function suggestForPrefix(surface: CommandSurface, query: string): SlashCommand[] {
  const stripped = query.replace(/^\/+/, '').toLowerCase()
  const all = commandsForSurface(surface)
  if (stripped.length === 0) return all
  return all.filter(c => c.name.startsWith(stripped))
}

/**
 * Permission modes operators can flip via /yolo and /perms. Matches
 * `PermissionMode` from `../permission` but redeclared here to avoid the
 * commands module taking a transitive dependency on the permission service.
 */
export type PermissionToggleMode = 'off' | 'prompt' | 'strict'

export interface PermissionApi {
  getMode(): PermissionToggleMode
  setMode(mode: PermissionToggleMode): void
}

export interface ApplyResult {
  /** Operator-facing message describing the new state. */
  message: string
  /** Mode after the operation, for callers that mirror UI state. */
  mode: PermissionToggleMode
}

/**
 * Toggle approval prompts between `off` (YOLO) and `prompt` (re-enable).
 * `strict` flips to `prompt` on toggle to give an off-ramp from lockdown.
 * Single source of truth; consumed by TUI `/yolo`, TG-local `/yolo`, and
 * gateway TG `/yolo` so wording stays in lockstep.
 */
export function applyYolo(permission: PermissionApi): ApplyResult {
  const cur = permission.getMode()
  const next: PermissionToggleMode = cur === 'off' ? 'prompt' : 'off'
  permission.setMode(next)
  return {
    mode: next,
    message:
      next === 'off'
        ? 'YOLO ON. Approval prompts disabled for this session.'
        : 'YOLO OFF. Approvals back on.',
  }
}

/**
 * Set the permission mode explicitly. `arg === undefined` returns the current
 * mode without mutation. Returns the same `{ message, mode }` shape so callers
 * have one branch instead of two for "show vs set".
 */
export function applyPerms(
  permission: PermissionApi,
  arg: string | undefined,
): ApplyResult | { message: string; mode: PermissionToggleMode; error: true } {
  if (!arg) {
    const mode = permission.getMode()
    return { mode, message: `perms: ${mode}` }
  }
  const lower = arg.toLowerCase()
  if (lower !== 'off' && lower !== 'prompt' && lower !== 'strict') {
    return {
      mode: permission.getMode(),
      message: `unknown perms mode '${arg}'. try: off | prompt | strict`,
      error: true,
    }
  }
  permission.setMode(lower as PermissionToggleMode)
  return { mode: lower as PermissionToggleMode, message: `perms set to ${lower}` }
}
