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
  agentPaths,
  buildOperatorSession,
  iNFTAgentId,
  isOperatorSessionComplete,
  precomputeAllScopes,
  readOperatorSession,
  requiredScopesForAgent,
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

  // v0.23.2: if the socket exists, check for version drift. If the running
  // daemon's version differs from the on-disk CLI binary, auto-restart so
  // operators don't have to remember `anima gateway restart` after every
  // `bun add -g @s0nderlabs/anima@N`. If versions match, bail with the
  // legacy "already running" error.
  if (existsSync(socketPath)) {
    const { createHash } = await import('node:crypto')
    const { homedir } = await import('node:os')
    const identityHash = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
    const lockFile = join(homedir(), '.anima', 'locks', `anima-gateway-${identityHash}.lock`)
    const { ensureGatewayVersionMatchesCli } = await import('../util/gateway-version')
    const drift = await ensureGatewayVersionMatchesCli({ socketPath, lockFile })
    if (drift.action === 'ok' || drift.action === 'no-cli-version') {
      console.error(
        `anima gateway start: socket already exists at ${socketPath} — gateway may be running (version ${drift.daemonVersion ?? 'unknown'}). Try \`anima gateway stop\` first.`,
      )
      process.exit(1)
    }
    console.log(`note: ${drift.note}`)
  }

  // v0.21.12: derive the set of scope keys this agent's daemon will need
  // based on what's on disk (always 'keystore'; adds 'telegram' when
  // telegram-secrets.encrypted is present, etc.). The cached session is only
  // "complete enough to skip Touch ID" when it contains every required key.
  // Pre-fix, this used the binary `isOperatorSessionFresh` which returned
  // true for any non-expired session, even one written by a path that didn't
  // derive TELEGRAM. The daemon then booted, found no telegram scope key,
  // and silently dropped all inbound TG messages.
  const required = requiredScopesForAgent(agentId)
  const extraScopes = required.filter((s): s is Exclude<typeof s, 'keystore'> => s !== 'keystore')
  const complete = isOperatorSessionComplete(agentId, required)
  if (!complete) {
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

    sUnlock.message(`Deriving scope keys (${required.join(' + ')})`)
    try {
      const keys = await precomputeAllScopes(operator, agentAddress, extraScopes)
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
    console.log(`operator-session complete (${required.join(' + ')}); skipping Touch ID`)
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
    // v0.21.12: redirect daemon stdout/stderr to gateway.log (default
    // 'log-file' mode) so boot errors survive the parent's exit. Operators
    // see the log via `anima gateway logs` or by tailing
    // ~/.anima/agents/<id>/gateway.log directly.
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
