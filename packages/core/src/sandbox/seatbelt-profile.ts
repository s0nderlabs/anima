/**
 * macOS seatbelt (SBPL) profile generator. Used by MacOSSandboxExecBackend to
 * build the `-p` argument for `sandbox-exec`.
 *
 * Profile policy (deny-default + targeted allows):
 *
 *   READS: broad (allow file-read*). Reading is fine; it's writes + network
 *   exfil + process-fork-into-system that need gating. The brain's job is to
 *   help with files; we don't want it crippled on read.
 *
 *   WRITES: deny default, allow ONLY:
 *     - agentDir (anima state)
 *     - workspaceRoot (the cwd anima was launched from; fs.write authorized
 *       through the modal lands here)
 *     - /tmp/anima-* (anima's own temp scratch — code.execute snippets, etc.)
 *     - /private/tmp/anima-* (macOS canonical /tmp)
 *     - /var/folders (macOS user temp dir, where mkdtemp() defaults land)
 *     - any extra subpaths in `extraWriteAllow`
 *
 *   EXPLICIT WRITE DENY (overrides allows on overlap):
 *     - $HOME/.ssh
 *     - $HOME/.aws
 *     - $HOME/Library/Keychains
 *     - $HOME/.config/gcloud
 *     - $HOME/.anima (the broader anima state tree — only the agent's own
 *       agentDir is allowed; brain shouldn't rewrite ~/.anima/config.ts)
 *
 *   NETWORK: allow* (anima legitimately needs 0G RPC, indexer, compute,
 *   WC relay, plus user-asked-for HTTP). Future hardening: allowlist by host.
 *
 *   PROCESS: allow process-fork + process-exec (tools spawn child binaries).
 *   IPC: allow mach-lookup, ipc-posix-shm, signal — needed by most CLI
 *   tooling, otherwise the simplest commands fail.
 *
 * The seatbelt syntax is Apple's internal SBPL (Scheme-like). It's
 * undocumented officially but stable across macOS versions; deprecated in
 * `man sandbox-exec` but still functional and used by Apple itself for many
 * system services.
 *
 * NOTE on order: in seatbelt SBPL, deny rules placed AFTER allows take
 * precedence on overlap. So we put the denylist after the allowlist for
 * credentials.
 */

import { credentialDirs } from './credentials'

export interface SeatbeltProfileOpts {
  agentDir: string
  workspaceRoot: string
  homedir: string
  extraWriteAllow?: string[]
  extraWriteDeny?: string[]
}

/**
 * Escape a path for safe inclusion in an SBPL string literal. Seatbelt strings
 * are double-quoted; embedded backslashes and double quotes need escaping.
 * Newlines also break the parser. Anima paths come from process.cwd() and
 * homedir() so they're well-formed Unix paths in practice, but we escape
 * defensively.
 */
function sbplEscape(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

export function buildSeatbeltProfile(opts: SeatbeltProfileOpts): string {
  const home = sbplEscape(opts.homedir)
  const agent = sbplEscape(opts.agentDir)
  const workspace = sbplEscape(opts.workspaceRoot)

  const allowSubpaths = [
    `(allow file-write* (subpath "${agent}"))`,
    `(allow file-write* (subpath "${workspace}"))`,
    `(allow file-write* (regex #"^/tmp/anima-"))`,
    `(allow file-write* (regex #"^/private/tmp/anima-"))`,
    `(allow file-write* (subpath "/var/folders"))`,
    `(allow file-write* (subpath "/private/var/folders"))`,
    ...(opts.extraWriteAllow ?? []).map(p => `(allow file-write* (subpath "${sbplEscape(p)}"))`),
  ].join('\n  ')

  const credDirs = credentialDirs(opts.homedir).map(sbplEscape)
  const denySubpaths = [
    ...credDirs.map(p => `(deny file-write* (subpath "${p}"))`),
    `(deny file-write* (subpath "${home}/.anima"))`,
    ...(opts.extraWriteDeny ?? []).map(p => `(deny file-write* (subpath "${sbplEscape(p)}"))`),
  ].join('\n  ')

  // Read-side: allow broadly (the agent legitimately needs to read system
  // binaries, libraries, project files, etc.) but EXPLICITLY deny credential
  // dirs. This blocks `cat ~/.ssh/id_rsa` -- shell.run that bypasses
  // PathGuard's tool-level checks. Network is broad; if exfil is a concern
  // (read public file + POST somewhere), use Docker mode.
  const denyReadSubpaths = credDirs.map(p => `(deny file-read* (subpath "${p}"))`).join('\n  ')

  // The agentDir is under ~/.anima/agents/<id>/, and we deny ~/.anima broadly,
  // so we MUST re-allow agentDir AFTER the deny to keep anima's own state
  // writable. SBPL is order-sensitive: later rules win on overlap.
  return `(version 1)
(deny default)

;; Process management — tools spawn binaries.
(allow process-fork)
(allow process-exec)

;; IPC + system bookkeeping that any non-trivial CLI needs.
(allow mach-lookup)
(allow mach-priv-host-port)
(allow mach-task-name)
(allow ipc-posix-shm)
(allow signal)
(allow sysctl-read)
(allow sysctl-write)
(allow system-fsctl)
(allow system-info)
(allow system-socket)
(allow iokit-open)

;; Network — broad. Anima needs 0G RPC, indexer, compute, WC relay, plus
;; arbitrary HTTP for browse + brain-driven fetches. Tighten via allowlist
;; when we have explicit host policy.
(allow network*)

;; Reads — broad by default so binaries/libraries/project files work.
(allow file-read*)

;; Explicit credential read denies (override allow file-read*).
  ${denyReadSubpaths}

;; Writes — deny default, allowlist:
  ${allowSubpaths}

;; Explicit credential + state-tree denies (override allowlist on overlap).
  ${denySubpaths}

;; Re-allow agentDir AFTER the ~/.anima broad deny so anima's own state is
;; writable. SBPL applies later rules first, so this comes last.
  (allow file-write* (subpath "${agent}"))
`
}
