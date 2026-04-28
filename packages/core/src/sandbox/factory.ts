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
import { LinuxBubblewrapBackend } from './linux'
import { LocalBackend } from './local'
import { MacOSSandboxExecBackend } from './macos'
import type { SandboxBackend, SandboxBackendOpts, SandboxMode } from './types'

export interface MakeSandboxOpts extends SandboxBackendOpts {
  mode: SandboxMode
  /** Override platform detection. Defaults to process.platform. Test hook. */
  platform?: NodeJS.Platform
  /** Sink for the platform-fallback warning. Defaults to process.stderr.write. */
  warn?: (msg: string) => void
  /** docker mode: container image override (default `nikolaik/python-nodejs:python3.11-nodejs20`). */
  dockerImage?: string
  /** docker mode: bind-mount workspaceRoot into container at /workspace (default false). */
  dockerMountWorkspace?: boolean
  /** docker mode: force a specific runtime binary path (auto-detect by default). */
  dockerRuntimePath?: string
  /** docker mode: CPU cores cap (`--cpus`). Unset = unlimited. */
  dockerCpu?: number
  /** docker mode: memory cap in MB (`--memory <N>m`). Unset = unlimited. */
  dockerMemoryMb?: number
  /** docker mode: per-container disk cap in MB. Linux+overlay2 only; ignored on darwin. */
  dockerDiskMb?: number
  /** docker mode: block all network from inside container (`--network=none`). Default false. */
  dockerNoNetwork?: boolean
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
        cpu: opts.dockerCpu,
        memoryMb: opts.dockerMemoryMb,
        diskMb: opts.dockerDiskMb,
        noNetwork: opts.dockerNoNetwork,
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
    try {
      return new LinuxBubblewrapBackend(opts)
    } catch (err) {
      warn(
        `anima: linux bubblewrap sandbox failed to initialize, falling back to passthrough: ${(err as Error).message}\n`,
      )
      return new LocalBackend()
    }
  }

  warn(
    `anima: sandbox.mode="os" not supported on platform "${platform}", falling back to passthrough\n`,
  )
  return new LocalBackend()
}
