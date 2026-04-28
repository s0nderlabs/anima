/**
 * macOS sandbox-exec backend. Wraps every tool spawn in:
 *
 *   sandbox-exec -p '<seatbelt-profile>' <orig-command> <orig-args...>
 *
 * `sandbox-exec` is at /usr/bin/sandbox-exec on every macOS install. The
 * `man` page calls it "deprecated" in favour of the modern App Sandbox API,
 * but it's still ships and is used by Apple internally; verified working on
 * macOS 25.4.0. The deprecation is a recommendation that new GUI apps adopt
 * App Sandbox, not a removal.
 *
 * The profile is built once at backend-init and reused for every spawn. The
 * profile is passed inline via `-p` (no temp file management needed).
 */

import { existsSync } from 'node:fs'
import { buildSeatbeltProfile } from './seatbelt-profile'
import type {
  SandboxBackend,
  SandboxBackendOpts,
  SandboxEnvHint,
  SandboxSpawnRequest,
  WrappedSpawn,
} from './types'

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'

export class MacOSSandboxExecBackend implements SandboxBackend {
  readonly mode = 'os' as const
  readonly label = 'os:darwin'
  private readonly profile: string

  constructor(opts: SandboxBackendOpts) {
    if (!existsSync(SANDBOX_EXEC_PATH)) {
      throw new Error(
        `sandbox-exec not found at ${SANDBOX_EXEC_PATH}. macOS sandbox backend requires the system tool.`,
      )
    }
    this.profile = buildSeatbeltProfile({
      agentDir: opts.agentDir,
      workspaceRoot: opts.workspaceRoot,
      homedir: opts.homedir,
      extraWriteAllow: opts.extraWriteAllow,
      extraWriteDeny: opts.extraWriteDeny,
    })
  }

  /** Test-only accessor for the rendered profile. */
  getProfile(): string {
    return this.profile
  }

  envHint(): SandboxEnvHint {
    return {
      mode: 'os',
      label: this.label,
      innerOs: 'darwin',
      workspaceMount: null,
      scope:
        'shell.run, code.execute, shell.process_start are wrapped in sandbox-exec; writes outside agentDir + cwd + /tmp/anima-* are denied',
    }
  }

  async wrapSpawn(req: SandboxSpawnRequest): Promise<WrappedSpawn> {
    return {
      command: SANDBOX_EXEC_PATH,
      args: ['-p', this.profile, req.command, ...req.args],
      options: req.options,
    }
  }
}
