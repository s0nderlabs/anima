/**
 * Factory: build the right backend for the configured mode + current platform.
 *
 *   mode='none'   → LocalBackend (passthrough)
 *   mode='os' on darwin → MacOSSandboxExecBackend (sandbox-exec wrapper)
 *   mode='os' on linux  → LocalBackend + warning (bubblewrap impl pending)
 *   mode='os' elsewhere → LocalBackend + warning
 *   mode='docker' → throws "not yet implemented" (separate bundle)
 *
 * Failure mode: misconfiguration silently degrades to LocalBackend with a
 * stderr warning rather than crashing init. Anima MUST boot even on
 * unsupported platforms; the sandbox is a defense-in-depth layer, not a hard
 * requirement.
 */

import { DockerBackend } from './docker'
import { LocalBackend } from './local'
import { MacOSSandboxExecBackend } from './macos'
import type { SandboxBackend, SandboxBackendOpts, SandboxMode } from './types'

export interface MakeSandboxOpts extends SandboxBackendOpts {
  mode: SandboxMode
  /** Override platform detection. Defaults to process.platform. Test hook. */
  platform?: NodeJS.Platform
  /** Sink for the platform-fallback warning. Defaults to process.stderr.write. */
  warn?: (msg: string) => void
  /** docker mode: container image override (default `oven/bun:1`). */
  dockerImage?: string
  /** docker mode: bind-mount workspaceRoot into container at /workspace (default false). */
  dockerMountWorkspace?: boolean
  /** docker mode: force a specific runtime binary path (auto-detect by default). */
  dockerRuntimePath?: string
}

export function makeSandboxBackend(opts: MakeSandboxOpts): SandboxBackend {
  const platform = opts.platform ?? process.platform
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m))

  if (opts.mode === 'none') return new LocalBackend()

  if (opts.mode === 'docker') {
    try {
      return new DockerBackend({
        agentDir: opts.agentDir,
        workspaceRoot: opts.workspaceRoot,
        homedir: opts.homedir,
        image: opts.dockerImage,
        mountWorkspace: opts.dockerMountWorkspace,
        runtimePath: opts.dockerRuntimePath,
      })
    } catch (err) {
      warn(
        `anima: docker sandbox failed to initialize, falling back to passthrough: ${(err as Error).message}\n`,
      )
      return new LocalBackend()
    }
  }

  // mode === 'os'
  if (platform === 'darwin') {
    try {
      return new MacOSSandboxExecBackend(opts)
    } catch (err) {
      warn(
        `anima: macOS sandbox-exec failed to initialize, falling back to passthrough: ${(err as Error).message}\n`,
      )
      return new LocalBackend()
    }
  }

  if (platform === 'linux') {
    warn(
      `anima: sandbox.mode="os" on linux is not yet implemented (bubblewrap pending), falling back to passthrough\n`,
    )
    return new LocalBackend()
  }

  warn(
    `anima: sandbox.mode="os" not supported on platform "${platform}", falling back to passthrough\n`,
  )
  return new LocalBackend()
}
