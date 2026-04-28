/**
 * Passthrough backend. Used when `sandbox.mode = 'none'` (today's default for
 * back-compat) or when the platform doesn't support `os` mode.
 */

import type { SandboxBackend, SandboxSpawnRequest, WrappedSpawn } from './types'

export class LocalBackend implements SandboxBackend {
  readonly mode = 'none' as const
  readonly label = 'none'

  async wrapSpawn(req: SandboxSpawnRequest): Promise<WrappedSpawn> {
    return {
      command: req.command,
      args: req.args,
      options: req.options,
    }
  }
}
