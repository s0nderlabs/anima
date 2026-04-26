import { homedir } from 'node:os'
import { resolve } from 'node:path'

/**
 * Default denylist for `fs.write` / `fs.patch` writes. Hard-deny paths whose
 * compromise would let the agent leak operator credentials or system state:
 *
 *   - SSH/AWS/GCP credential trees (~/.ssh, ~/.aws, ~/.config/gcloud)
 *   - Dotenv-style files (.env, .env.local, etc.)
 *   - System config (/etc/, /boot/, /usr/local/etc/)
 *   - The anima state tree itself (`agentDir` and parent `~/.anima/`)
 *     so the brain can't rewrite its own config or operator keystore.
 *
 * The constructor takes the agentDir explicitly so each ToolRegistry instance
 * has the right denylist for its agent.
 */
export interface PathGuardOpts {
  agentDir: string
  /** Extra absolute paths to deny (test override). */
  extraDeny?: string[]
}

export interface PathGuardResult {
  allowed: boolean
  reason?: string
}

const DEFAULT_DENY_PATTERNS: RegExp[] = [
  /\.ssh(\/|$)/,
  /\.aws(\/|$)/,
  /\.config\/gcloud(\/|$)/,
  /(^|\/)\.env(\.|$)/,
  /^\/etc\//,
  /^\/boot\//,
  /^\/usr\/local\/etc\//,
  /^\/var\/log\//,
  /^\/sys(\/|$)/,
  /^\/proc(\/|$)/,
  /^\/dev(\/|$)/,
]

export class PathGuard {
  private readonly absolutePathsDenied: string[]

  constructor(private readonly opts: PathGuardOpts) {
    const home = homedir()
    const animaRoot = resolve(home, '.anima')
    this.absolutePathsDenied = [
      // Anima state tree: the agent's own config + keystore must be off-limits.
      resolve(opts.agentDir),
      animaRoot,
      // Common dev secret locations.
      resolve(home, '.ssh'),
      resolve(home, '.aws'),
      resolve(home, '.config', 'gcloud'),
      ...(opts.extraDeny ?? []),
    ]
  }

  check(rawPath: string): PathGuardResult {
    let abs: string
    try {
      abs = resolve(rawPath.startsWith('~') ? rawPath.replace('~', homedir()) : rawPath)
    } catch {
      return { allowed: false, reason: 'unresolvable path' }
    }
    for (const denied of this.absolutePathsDenied) {
      if (abs === denied || abs.startsWith(`${denied}/`)) {
        return { allowed: false, reason: `protected path: ${denied}` }
      }
    }
    for (const re of DEFAULT_DENY_PATTERNS) {
      if (re.test(abs)) {
        return { allowed: false, reason: `protected path pattern: ${re.source}` }
      }
    }
    return { allowed: true }
  }
}
