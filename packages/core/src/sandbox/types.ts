/**
 * Sandbox abstraction for limb execution.
 *
 * Phase 9.5 (Apr 28 2026 incident response). Anima's limbs run on the operator's
 * host. Permission floors (PathGuard + dangerous-pattern modal + strict/prompt/yolo)
 * caught the rm correctly during the v0.9.3 benchmark, but once the modal granted
 * `s` (allow session), the command ran on the real host with full FS access. The
 * cascade (tmux socket → daemon detach → orphan name-slot blocking) was severe.
 *
 * This module adds a structural layer BENEATH the permission floor: every
 * spawn() call from a tool is routed through a `SandboxBackend` which can wrap
 * the command in an OS sandbox before execution. Even if the permission floor
 * is bypassed (yolo, allow-session, allow-once), the sandbox profile prevents
 * writes outside an allowlist.
 *
 * Mirrors hermes-agent's TERMINAL_ENV pattern (local | docker | modal | daytona |
 * singularity | ssh) but starts smaller: `none` (passthrough) and `os` (macOS
 * sandbox-exec / future Linux bubblewrap). Docker mode is a separate followup
 * bundle.
 */

import type { SpawnOptions } from 'node:child_process'

/**
 * Mode selector. Lives under `sandbox.mode` in `~/.anima/config.ts`.
 *
 *  - `none`: passthrough (today's behaviour). No sandboxing applied. Default
 *    for backward compatibility while Tier 2 stabilizes.
 *  - `os`: native OS sandbox. macOS uses sandbox-exec with a deny-default
 *    seatbelt profile. Linux uses bubblewrap (post-MVP). On unsupported
 *    platforms falls back to `none` with a startup warning.
 *  - `docker`: long-lived container per session, every spawn goes through
 *    `docker exec`. Future bundle.
 */
export type SandboxMode = 'none' | 'os' | 'docker'

/**
 * Inputs the factory needs to construct a backend.
 *  - `agentDir`: write-allowed (anima writes activity log, mcp debug, etc.).
 *  - `workspaceRoot`: write-allowed (where the operator launched anima from;
 *    fs.write/fs.patch authorized through the modal land here).
 *  - `homedir`: used by the seatbelt profile to deny secret-bearing subdirs
 *    (`~/.ssh`, `~/.aws`, `~/Library/Keychains`, `~/.config/gcloud`).
 *  - `extraWriteAllow`: optional extra subpaths to allow writes under (test
 *    sandbox dirs, custom workspaces).
 *  - `extraWriteDeny`: optional extra subpaths to explicitly block writes.
 */
export interface SandboxBackendOpts {
  agentDir: string
  workspaceRoot: string
  homedir: string
  extraWriteAllow?: string[]
  extraWriteDeny?: string[]
}

/**
 * One spawn request, fully described before the backend wraps it. We pass
 * `argv` rather than the legacy `(command, options)` form because backends
 * that prepend `sandbox-exec -p ...` need to construct an explicit argv;
 * mixing `shell: true` with a wrapper produces confused quoting.
 */
export interface WrappedSpawn {
  /** The binary that should actually be exec'd. May be the original, may be a wrapper. */
  command: string
  /** Args to pass. Wrapper backends prepend their own. */
  args: string[]
  /** SpawnOptions to pass through. `shell` is intentionally omitted because the wrapper builds the explicit argv. */
  options: SpawnOptions
}

/**
 * Inputs the tool layer hands the backend per spawn. The backend wraps the
 * argv (e.g. prepend `sandbox-exec -p <profile>` or rewrite as `docker exec
 * <containerId> ...`). For shell.run-style tools, the caller MUST pass an
 * explicit argv (`command='/bin/sh', args=['-c', userCommand]`) — the backend
 * cannot use `shell: true` because the wrapper builds the argv itself.
 */
export interface SandboxSpawnRequest {
  command: string
  args: string[]
  options: SpawnOptions
}

/**
 * Environment hint surfaced to the brain via the frozen prefix's # Environment
 * block. Lets the brain skip the "run pwd + ls / + uname to figure out where
 * I am" empirical-discovery dance — saves wasted tool calls when the brain
 * defaults to host-style commands inside a Linux container (BSD sed, fs.read
 * /workspace ENOENT, etc.).
 *
 * Each non-passthrough backend implements `envHint()` to surface its specific
 * shape. `LocalBackend` returns null (no sandbox, no hint).
 */
export interface SandboxEnvHint {
  mode: SandboxMode
  label: string
  innerOs?: 'linux' | 'darwin' | null
  workspaceMount?: string | null
  scope?: string | null
}

/**
 * The backend interface. Implementations: LocalBackend (passthrough),
 * MacOSSandboxExecBackend (sandbox-exec wrapper), LinuxBubblewrapBackend
 * (bwrap wrapper), DockerBackend (per-session container).
 *
 * `wrapSpawn` is async to allow lifecycle work (e.g. DockerBackend lazy-starts
 * the container on first call). Sync backends just `return Promise.resolve(...)`.
 * Optional `dispose` lets backends clean up (DockerBackend kills its container).
 * Optional `envHint` returns a brain-facing description of the sandbox shape.
 */
export interface SandboxBackend {
  /** Backend identifier surfaced in logs / debug output. */
  readonly mode: SandboxMode
  /** Backend label including platform detail (e.g. 'os:darwin', 'docker:oven/bun:1'). */
  readonly label: string
  /**
   * Wrap a spawn request. Returns (a Promise of) the argv that should be
   * passed to `spawn(command, args, options)`. For `none`, returns the request
   * unchanged. For `os`, returns a sandbox-exec wrapper. For `docker`, returns
   * `docker exec <containerId> <orig-command>`, awaiting container start on
   * the first call.
   */
  wrapSpawn(req: SandboxSpawnRequest): Promise<WrappedSpawn>
  /** Optional cleanup (kill long-lived containers, remove temp files). Called on anima exit. */
  dispose?(): Promise<void>
  /** Optional brain-facing description of the sandbox shape. Null for passthrough. */
  envHint?(): SandboxEnvHint | null
}
