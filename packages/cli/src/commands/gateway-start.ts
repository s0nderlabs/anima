/**
 * `anima gateway start` — interactive Touch ID + write operator-session,
 * then fork the gateway daemon detached.
 *
 * Flow:
 *   1. Load config from ~/.anima/config.ts
 *   2. Resolve agentId (override via --agent or first agent in config)
 *   3. Check if gateway already running (lock file). If yes, error.
 *   4. Pick operator signer + interactive Touch ID via existing operator-picker
 *   5. Pre-derive scope keys via precomputeAllScopes (keystore + telegram)
 *   6. Write operator-session file (perm 0600, 24h TTL)
 *   7. Spawn anima-gateway-local detached + wait for socket to become readable
 *      (proves the daemon booted cleanly)
 *   8. Print pid + socket path
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spinner } from '@clack/prompts'
import {
  OPERATOR_BLOB_SCOPES,
  agentPaths,
  buildOperatorSession,
  iNFTAgentId,
  isOperatorSessionFresh,
  precomputeAllScopes,
  readOperatorSession,
  writeOperatorSession,
} from '@s0nderlabs/anima-core'
import { type Address, getAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { spawnGatewayDaemon } from '../util/gateway-spawn'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export interface GatewayStartOpts {
  agentId?: string
}

export async function runGatewayStart(opts: GatewayStartOpts): Promise<void> {
  const found = await findAndLoadConfig()
  if (!found?.config) {
    console.error('anima gateway start: no anima.config.ts found in cwd or ~/.anima/')
    process.exit(1)
  }
  const config = found.config
  const contractAddress = getAddress(config.identity.iNFT!.contract as Address)
  const tokenId = BigInt(config.identity.iNFT!.tokenId)
  const agentId = opts.agentId ?? iNFTAgentId({ contractAddress, tokenId })
  const paths = agentPaths.agent(agentId)
  const agentAddress = getAddress(config.identity.agent as Address)
  const socketPath = join(paths.dir, 'gateway.sock')

  // If the socket exists, the gateway might already be running. Heuristic:
  // try to connect. For now: abort if socket file exists.
  if (existsSync(socketPath)) {
    console.error(
      `anima gateway start: socket already exists at ${socketPath} — gateway may be running. Try \`anima gateway stop\` first.`,
    )
    process.exit(1)
  }

  // If a fresh operator-session already exists, skip the unlock step.
  const fresh = isOperatorSessionFresh(agentId)
  if (!fresh) {
    const sUnlock = spinner()
    sUnlock.start('Unlocking operator wallet for session-key derivation')
    let operator: Awaited<ReturnType<typeof loadOrPickOperatorSigner>>
    try {
      operator = await loadOrPickOperatorSigner({
        network: config.network,
        hint: config.operator,
      })
    } catch (e) {
      sUnlock.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
      process.exit(1)
    }
    if (!operator) {
      sUnlock.stop('operator unlock cancelled')
      process.exit(1)
    }

    sUnlock.message('Deriving scope keys (keystore + telegram)')
    try {
      const keys = await precomputeAllScopes(operator, agentAddress, [
        OPERATOR_BLOB_SCOPES.TELEGRAM,
      ])
      const sess = buildOperatorSession({ agent: agentAddress, keys })
      writeOperatorSession(agentId, sess)
      sUnlock.stop('operator-session written (24h TTL)')
    } catch (e) {
      sUnlock.stop(`derive failed: ${(e as Error).message.slice(0, 160)}`)
      await operator.close?.()
      process.exit(1)
    }
    await operator.close?.()
  } else {
    console.log('operator-session already fresh; skipping Touch ID')
  }

  // Spawn gateway daemon detached. Inherit stdio for the first ~3s so the
  // user sees boot errors, then redirect to log file when ready.
  const sBoot = spinner()
  sBoot.start(`Spawning gateway daemon (agent=${agentId.slice(0, 8)}…)`)

  const result = await spawnGatewayDaemon({
    agentId,
    configPath: found.path ?? '',
    socketPath,
    timeoutMs: 10_000,
    stdio: 'inherit',
  })
  if (result.ready) {
    sBoot.stop(`gateway running pid=${result.pid} socket=${socketPath}`)
    console.log('stop with: anima gateway stop')
    console.log('logs:      anima gateway logs -f')
  } else {
    const reason = result.reason ?? 'unknown'
    const detail = result.error ? `: ${result.error}` : ''
    sBoot.stop(
      `gateway did not bind socket within 10s (reason=${reason} pid=${result.pid ?? '?'})${detail}; check above output`,
    )
    process.exit(1)
  }
}

// Stub — wired by gateway-status when needed.
export function _operatorSessionPresent(agentId: string): boolean {
  return readOperatorSession(agentId) !== null
}
