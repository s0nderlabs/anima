/**
 * `anima gateway run` — foreground daemon (blocks; Ctrl+C to stop).
 *
 * Spawns `anima-gateway-local` (the bin in @s0nderlabs/anima-gateway) with
 * inherit stdio so the user sees logs live. Reads operator-session for the
 * cached AES keys; fails loud if no session exists ("run anima gateway start
 * first").
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface GatewayRunOpts {
  agentId?: string
}

function resolveLocalBin(): string {
  // Resolve the gateway package location from this CLI's perspective. Works
  // both in the workspace dev tree and in installed npm node_modules.
  const pkgUrl = import.meta.resolve('@s0nderlabs/anima-gateway/package.json')
  const pkgRoot = dirname(fileURLToPath(pkgUrl))
  return join(pkgRoot, 'bin', 'anima-gateway-local')
}

export async function runGatewayForeground(opts: GatewayRunOpts): Promise<void> {
  const env = { ...process.env }
  if (opts.agentId) env.ANIMA_AGENT_ID = opts.agentId
  // Default ANIMA_CONFIG to ~/.anima/config.ts if not already set.
  if (!env.ANIMA_CONFIG) {
    env.ANIMA_CONFIG = join(env.HOME ?? '', '.anima', 'config.ts')
  }

  const localBin = resolveLocalBin()
  const proc = spawn('bun', [localBin], {
    env,
    stdio: 'inherit',
  })
  proc.on('exit', code => process.exit(code ?? 0))
  proc.on('error', err => {
    console.error(`anima gateway run: spawn failed — ${err.message}`)
    process.exit(1)
  })

  const forwardSignal = (sig: NodeJS.Signals): void => {
    if (!proc.killed) proc.kill(sig)
  }
  process.on('SIGINT', () => forwardSignal('SIGINT'))
  process.on('SIGTERM', () => forwardSignal('SIGTERM'))
}
