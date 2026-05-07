/**
 * v0.21.5 Bundle B: spawn-and-wait helper for the local gateway daemon.
 *
 * Two callers share this:
 *   - `anima gateway start` (interactive Touch ID flow → spawn detached)
 *   - `anima` chat fallback when no sock is present (auto-spawn before
 *     embedded TUI fallthrough — see Bundle C / chat.tsx)
 *
 * The helper does NOT perform operator-session unlock. Callers that need a
 * fresh session must run that path before invoking this. If the daemon dies
 * during boot because no session exists, the sock never appears and we
 * surface the failure as `{ ready: false, reason: 'timeout' }`.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SpawnGatewayDaemonOpts {
  agentId: string
  configPath: string
  socketPath: string
  /** Max ms to wait for the unix sock to appear. Default 10_000. */
  timeoutMs?: number
  /** Where to send daemon stdout/stderr. Default 'inherit' (so user sees boot errors). */
  stdio?: 'inherit' | 'ignore'
  /** Override the bin resolution (tests). */
  binPath?: string
  /** Override env (tests). */
  env?: NodeJS.ProcessEnv
}

export interface SpawnGatewayDaemonResult {
  ready: boolean
  /** Detached child PID iff spawn succeeded (regardless of readiness). */
  pid?: number
  /** Reason populated on failure: 'spawn-failed' | 'timeout' | 'pre-existing'. */
  reason?: 'spawn-failed' | 'timeout' | 'pre-existing'
  /** First-line error message when spawn failed. */
  error?: string
}

export function resolveLocalBin(): string {
  const pkgUrl = import.meta.resolve('@s0nderlabs/anima-gateway/package.json')
  const pkgRoot = dirname(fileURLToPath(pkgUrl))
  return join(pkgRoot, 'bin', 'anima-gateway-local')
}

export async function spawnGatewayDaemon(
  opts: SpawnGatewayDaemonOpts,
): Promise<SpawnGatewayDaemonResult> {
  if (existsSync(opts.socketPath)) {
    return { ready: false, reason: 'pre-existing' }
  }

  const bin = opts.binPath ?? resolveLocalBin()
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    ANIMA_AGENT_ID: opts.agentId,
    ANIMA_CONFIG: opts.configPath,
  }
  const stdioMode = opts.stdio ?? 'inherit'

  let proc: ChildProcess
  try {
    proc = spawn('bun', [bin], {
      env,
      detached: true,
      stdio: ['ignore', stdioMode, stdioMode],
    })
    proc.unref()
  } catch (err) {
    return {
      ready: false,
      reason: 'spawn-failed',
      error: (err as Error).message?.slice(0, 200),
    }
  }

  const timeoutMs = opts.timeoutMs ?? 10_000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(opts.socketPath)) {
      return { ready: true, pid: proc.pid }
    }
    await new Promise(r => setTimeout(r, 200))
  }
  return {
    ready: false,
    pid: proc.pid,
    reason: 'timeout',
  }
}
