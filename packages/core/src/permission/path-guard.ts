import { realpathSync } from 'node:fs'
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

/**
 * macOS `/var/folders/...` resolves to `/private/var/folders/...` via symlink;
 * Linux is usually direct. `path.resolve()` does NOT follow symlinks, so a
 * naive textual compare would let a brain that addresses the canonical form
 * smuggle past the denylist. Canonicalise at construction (and at check time)
 * so both forms are caught.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Both forms of one denylist entry, so as-given OR canonical can match. */
function denyEntry(p: string): string[] {
  const raw = resolve(p)
  const canon = safeRealpath(raw)
  return raw === canon ? [raw] : [raw, canon]
}

export class PathGuard {
  private readonly absolutePathsDenied: string[]

  constructor(private readonly opts: PathGuardOpts) {
    const home = homedir()
    const animaRoot = resolve(home, '.anima')
    // Each protected location contributes BOTH the raw resolve()'d form and
    // the realpath-canonical form. macOS resolves /var/folders to /private/...
    // and a path being checked may not exist yet (e.g. fs.write of a new file
    // inside agentDir), so realpath at check time would return the raw form.
    // Storing both at construction lets either match.
    this.absolutePathsDenied = [
      ...denyEntry(opts.agentDir),
      ...denyEntry(animaRoot),
      ...denyEntry(resolve(home, '.ssh')),
      ...denyEntry(resolve(home, '.aws')),
      ...denyEntry(resolve(home, '.config', 'gcloud')),
      ...(opts.extraDeny ?? []).flatMap(p => denyEntry(p)),
    ]
  }

  check(rawPath: string): PathGuardResult {
    let abs: string
    try {
      abs = resolve(rawPath.startsWith('~') ? rawPath.replace('~', homedir()) : rawPath)
    } catch {
      return { allowed: false, reason: 'unresolvable path' }
    }
    // Check both the as-given form (`/var/folders/.../foo`) and the canonical
    // form (`/private/var/folders/.../foo`) — either matching the denylist
    // is a hit. Cheap (one realpath syscall) and closes a real bypass hole.
    const canonical = safeRealpath(abs)
    for (const denied of this.absolutePathsDenied) {
      if (
        abs === denied ||
        abs.startsWith(`${denied}/`) ||
        canonical === denied ||
        canonical.startsWith(`${denied}/`)
      ) {
        return { allowed: false, reason: `protected path: ${denied}` }
      }
    }
    for (const re of DEFAULT_DENY_PATTERNS) {
      if (re.test(abs) || re.test(canonical)) {
        return { allowed: false, reason: `protected path pattern: ${re.source}` }
      }
    }
    return { allowed: true }
  }
}
