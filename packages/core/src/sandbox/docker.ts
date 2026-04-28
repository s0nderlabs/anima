/**
 * Container sandbox backend (Tier 3, Phase 9.5 follow-up to sandbox-exec).
 *
 * Works with EITHER Docker Desktop OR Podman — they provide the same CLI.
 * Auto-detects the runtime; same default config works for both. Operator
 * can force a specific binary via `runtimePath` opt.
 *
 * Same isolation shape as hermes-agent's `TERMINAL_ENV=docker` mode (full Linux
 * container). Differences from Tier 2 (sandbox-exec):
 *
 *  - Container has its own filesystem (chroot-like). Host fs invisible to the
 *    sandboxed processes unless explicitly mounted via `mountWorkspace=true`.
 *  - Container has its own /tmp, /etc, /home — `rm -rf /tmp/*` only nukes the
 *    container's tmpdir, never the host's.
 *  - Network goes through the runtime's bridge by default (still allowed for
 *    anima's RPC/storage/compute/WC traffic to escape the container).
 *  - Cold-start cost ~1s on the FIRST tool call after anima boot (longer if
 *    the image is being pulled). Subsequent `exec` calls are ~50-100ms.
 *
 * Hybrid MVP: only shell.run / shell.process_start / code.execute go through
 * the container. fs.* tools still run on host (gated by PathGuard). browser.*
 * still runs on host. A future bundle would re-exec all of anima inside the
 * container; this is the lower-risk incremental step.
 *
 * Lifecycle:
 *  - `wrapSpawn` lazy-starts the container on first call.
 *  - Container runs `nikolaik/python-nodejs:python3.11-nodejs20` by default
 *    (matches hermes' default; has bash, python3, node, npm, git, curl on
 *    standard PATH).
 *  - Container is detached (`run -d`), idle-loops on `tail -f /dev/null` so it
 *    stays alive between exec calls.
 *  - `dispose()` kills the container. chat.tsx wires this to process exit
 *    handlers.
 *
 * Failure modes:
 *  - Runtime not installed → constructor throws clear error; factory falls
 *    back to LocalBackend with stderr warning.
 *  - Daemon/machine not running → first call surfaces "daemon unreachable"
 *    error from the runtime. With podman on macOS, requires `podman machine
 *    start` once.
 *  - Image pull on first run → 30-60s, surfaced as "starting container" log.
 *  - Container crash mid-session → next wrapSpawn recreates it.
 */

import { type SpawnOptions, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { SandboxBackend, SandboxBackendOpts, SandboxSpawnRequest, WrappedSpawn } from './types'

const exec = promisify(execFile)

/**
 * Probe order for container runtime auto-detect. First existing path wins.
 * macOS Homebrew Podman lives at /opt/homebrew/bin/podman; Docker Desktop
 * symlinks /usr/local/bin/docker to its CLI (or to podman, on machines
 * with both). Linux paths included for completeness.
 */
const RUNTIME_CANDIDATES: ReadonlyArray<{ path: string; runtime: 'docker' | 'podman' }> = [
  { path: '/usr/local/bin/docker', runtime: 'docker' },
  { path: '/opt/homebrew/bin/docker', runtime: 'docker' },
  { path: '/opt/homebrew/bin/podman', runtime: 'podman' },
  { path: '/usr/bin/docker', runtime: 'docker' },
  { path: '/usr/bin/podman', runtime: 'podman' },
]

interface RuntimeInfo {
  path: string
  runtime: 'docker' | 'podman'
}

function detectRuntime(override?: string): RuntimeInfo {
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`container runtime override path does not exist: ${override}`)
    }
    const runtime = override.includes('podman') ? 'podman' : 'docker'
    return { path: override, runtime }
  }
  for (const cand of RUNTIME_CANDIDATES) {
    if (existsSync(cand.path)) return cand
  }
  throw new Error(
    'no container runtime found. Install Docker Desktop or Podman (`brew install podman`) and ensure the daemon/machine is running.',
  )
}

export interface DockerBackendOpts extends SandboxBackendOpts {
  /**
   * Container image. Default: `nikolaik/python-nodejs:python3.11-nodejs20`
   * (matches hermes-agent's TERMINAL_DOCKER_IMAGE default; has bash, python3,
   * node, npm, git, curl on standard PATH so every code.execute language and
   * shell tool works out of the box). Switch to `oven/bun:1` (~250MB vs 700MB)
   * if you only need bun/ts and don't care about python.
   */
  image?: string
  /**
   * Mount the host's workspaceRoot into the container at /workspace. Default
   * `false` for max isolation (container has no view of host fs). Set true
   * when the operator wants the agent to read/edit host project files.
   */
  mountWorkspace?: boolean
  /**
   * Override container runtime binary path. Default: auto-detect (docker, then
   * podman). Set this to force one or the other, e.g. `/opt/homebrew/bin/podman`.
   */
  runtimePath?: string
  /** Override container start timeout in ms. Default 60000 (60s for image pull). */
  startTimeoutMs?: number
}

export class DockerBackend implements SandboxBackend {
  readonly mode = 'docker' as const
  readonly label: string
  private readonly image: string
  private readonly mountWorkspace: boolean
  private readonly runtime: RuntimeInfo
  private readonly startTimeoutMs: number
  private readonly workspaceRoot: string
  private containerId: string | null = null
  private starting: Promise<string> | null = null

  constructor(opts: DockerBackendOpts) {
    this.image = opts.image ?? 'nikolaik/python-nodejs:python3.11-nodejs20'
    this.mountWorkspace = opts.mountWorkspace ?? false
    this.runtime = detectRuntime(opts.runtimePath)
    this.startTimeoutMs = opts.startTimeoutMs ?? 60_000
    this.workspaceRoot = opts.workspaceRoot
    this.label = `${this.runtime.runtime}:${this.image}${this.mountWorkspace ? '+workspace' : ''}`
  }

  /**
   * Lazy-starts the container on first call. Reuses on subsequent calls.
   * Synchronous assignment to `this.starting` BEFORE the first await ensures
   * concurrent first-callers all wait on the same Promise (otherwise each
   * read `this.starting === null`, each kicked off `startContainer`, and only
   * the last wrote — leaking N-1 orphan containers).
   */
  private ensureContainer(): Promise<string> {
    if (this.containerId) return Promise.resolve(this.containerId)
    if (this.starting) return this.starting
    const promise = this.startContainer().then(
      id => {
        this.containerId = id
        return id
      },
      err => {
        this.starting = null
        throw err
      },
    )
    this.starting = promise
    return promise
  }

  private async startContainer(): Promise<string> {
    // Verify the runtime daemon/machine is reachable. Fast-fail with a clear
    // error if not. Podman on macOS needs `podman machine start` once before
    // the API responds.
    try {
      await exec(this.runtime.path, ['version', '--format', '{{.Server.Version}}'], {
        timeout: 5_000,
      })
    } catch (err) {
      const hint =
        this.runtime.runtime === 'podman'
          ? "Run `podman machine start` if you haven't yet."
          : 'Start Docker Desktop.'
      throw new Error(
        `${this.runtime.runtime} daemon unreachable (${(err as Error).message}). ${hint} Or set sandbox.mode='os' / 'none'.`,
      )
    }

    const runArgs = ['run', '-d', '--rm', '--label', 'anima-sandbox=1']
    // Run as host UID so files created in a mounted workspace are owned by
    // the host user. Podman rootless on macOS handles this automatically; we
    // only force --user on docker/podman where the default would be root.
    if (this.runtime.runtime === 'docker') {
      runArgs.push('--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`)
    }
    if (this.mountWorkspace) {
      runArgs.push('-v', `${this.workspaceRoot}:/workspace`)
      runArgs.push('-w', '/workspace')
    }
    // Mount the host's tmpdir READ-ONLY at the same path inside the container
    // so code.execute's host-written snippet (mkdtemp + writeFile happen on
    // host, then `python3 <hostpath>` runs in container) is actually readable.
    // RO so the container can't write back — the container's own /tmp stays
    // isolated and `rm /var/folders/...` from inside fails with EROFS.
    const hostTmp = tmpdir()
    runArgs.push('-v', `${hostTmp}:${hostTmp}:ro`)
    runArgs.push(this.image, 'tail', '-f', '/dev/null')

    const { stdout } = await exec(this.runtime.path, runArgs, {
      timeout: this.startTimeoutMs,
    })
    const containerId = stdout.toString().trim()
    if (!containerId || containerId.length < 12) {
      throw new Error(
        `${this.runtime.runtime} run returned unexpected output: "${containerId.slice(0, 200)}"`,
      )
    }
    return containerId
  }

  async wrapSpawn(req: SandboxSpawnRequest): Promise<WrappedSpawn> {
    const containerId = await this.ensureContainer()
    // `exec -i` (interactive stdin), preserve env subset, run inside the
    // container. We pass env explicitly via `-e` rather than relying on
    // container env so redactedEnv from the tool layer actually reaches the
    // inner process.
    const envArgs: string[] = []
    if (req.options.env) {
      for (const [k, v] of Object.entries(req.options.env)) {
        if (typeof v === 'string') envArgs.push('-e', `${k}=${v}`)
      }
    }
    const cwdArg: string[] = []
    if (this.mountWorkspace && req.options.cwd === this.workspaceRoot) {
      cwdArg.push('-w', '/workspace')
    }
    // Strip cwd + env from passed-through options because we redirected both
    // into exec flags. Keep stdio/etc.
    const {
      cwd: _cwd,
      env: _env,
      ...passOptions
    } = req.options as SpawnOptions & {
      cwd?: unknown
      env?: unknown
    }
    return {
      command: this.runtime.path,
      args: ['exec', '-i', ...envArgs, ...cwdArg, containerId, req.command, ...req.args],
      options: passOptions,
    }
  }

  async dispose(): Promise<void> {
    if (!this.containerId) return
    const id = this.containerId
    this.containerId = null
    this.starting = null
    try {
      await exec(this.runtime.path, ['kill', id], { timeout: 5_000 })
    } catch {
      // Container may already be dead; --rm cleaned up. Best-effort.
    }
  }
}
