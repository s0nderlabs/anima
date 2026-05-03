#!/usr/bin/env bun
/**
 * Local-mode gateway entrypoint. Used by `anima gateway run` (foreground)
 * and `anima gateway start` (forks this into background).
 *
 * Differences from the sandbox entrypoint:
 *  - No ECIES bootstrap handshake. The agent privkey is decrypted in-process
 *    using a pre-derived AES key cached in the operator-session file (written
 *    by `anima gateway start` after a one-time Touch ID unlock).
 *  - Binds a unix socket at `~/.anima/agents/<id>/gateway.sock` (perm 0600)
 *    instead of TCP. File-perm-based authentication replaces EIP-191 sig
 *    verification (server-side `trustLocal: true`).
 *  - No Daytona-specific env vars (SANDBOX_ID, ANIMA_OPERATOR_ADDRESS).
 *    Identity is read from `~/.anima/config.ts` and the keystore is
 *    decrypted from the local cache at `~/.anima/agents/<id>/keystore.json`.
 *  - No self-heartbeat (Daytona-only concern).
 *  - PID lock at `~/.anima/agents/<id>/locks/gateway.lock` via the
 *    `acquireScopedLock` primitive shipped in v0.18.0.
 *
 * Required env (set by the parent `anima gateway` CLI):
 *   ANIMA_AGENT_ID  — 16-char hex iNFTAgentId; pins which agent's identity
 *                     to load. Falls back to the default agent if unset.
 *   ANIMA_CONFIG    — absolute path to anima.config.ts; default ~/.anima/config.ts
 */

import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  acquireScopedLock,
  agentPaths,
  decodeKeystoreBytes,
  decryptAgentKey,
  generateBootstrapKeypair,
  getSessionKey,
  iNFTAgentId,
  readOperatorSession,
} from '@s0nderlabs/anima-core'
import { type Address, type Hex, getAddress, isAddress } from 'viem'
import { ApprovalRelay } from './approval-relay'
import { EventHub } from './events'
import { RealRuntime } from './real-runtime'
import { createGatewayServer } from './server'
import {
  GATEWAY_VERSION,
  createSession,
  transitionToProvisioned,
  transitionToReady,
  transitionToShuttingDown,
} from './state'

interface MinimalConfig {
  identity: {
    iNFT: {
      contract: Address
      tokenId: string
    }
    agent: Address
    operator: Address
  }
  network: string
  [key: string]: unknown
}

async function loadConfig(path: string): Promise<MinimalConfig> {
  // anima.config.ts is a TS module; import dynamically via bun's resolver.
  const mod = (await import(path)) as { default: MinimalConfig }
  if (!mod.default?.identity?.iNFT?.contract) {
    throw new Error(`config at ${path} missing identity.iNFT.contract`)
  }
  return mod.default
}

function die(msg: string): never {
  process.stderr.write(`gateway: ${msg}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const configPath = process.env.ANIMA_CONFIG ?? join(process.env.HOME ?? '', '.anima', 'config.ts')
  if (!existsSync(configPath)) die(`config not found at ${configPath}`)

  const config = await loadConfig(configPath)
  const contractAddress = getAddress(config.identity.iNFT.contract)
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentId = process.env.ANIMA_AGENT_ID ?? iNFTAgentId({ contractAddress, tokenId })
  const paths = agentPaths.agent(agentId)
  if (!isAddress(config.identity.agent)) die('config.identity.agent is not a valid address')
  if (!isAddress(config.identity.operator)) die('config.identity.operator is not a valid address')
  const agentAddress: Address = getAddress(config.identity.agent)
  const operatorAddress: Address = getAddress(config.identity.operator)

  // Operator session is the cached AES key for keystore decrypt.
  const session = readOperatorSession(agentId)
  if (!session) {
    die(
      'no operator session — run `anima gateway start` first to unlock + cache the operator-derived key',
    )
  }
  const keystoreKey = getSessionKey(agentId, 'keystore')
  if (!keystoreKey) die('operator session is missing keystore key — re-run `anima gateway start`')

  // Read local keystore cache. v0.19.1 path assumes the cache exists from a
  // prior `anima init` or chat session. Cold-machine recovery via 0G Storage
  // is a v0.19.2 follow-up (needs config.network plumbed through).
  if (!existsSync(paths.keystore)) {
    die(
      `keystore cache not found at ${paths.keystore} — boot a chat session once or run \`anima restore\` to populate it`,
    )
  }
  const keystoreText = await readFile(paths.keystore, 'utf8')
  const keystore = decodeKeystoreBytes(new TextEncoder().encode(keystoreText))
  const agentPrivkey: Hex = await decryptAgentKey({
    keystore,
    agentAddress,
    precomputedKey: keystoreKey,
  })

  // Acquire host-wide gateway lock so two `anima gateway run` calls for the
  // same agent can't both bind the socket. 5-minute TTL with refresh below.
  const lockResult = acquireScopedLock({
    scope: 'anima-gateway',
    identity: agentId,
    ttl: 5 * 60,
  })
  if (!lockResult.acquired || !lockResult.handle) {
    die(`gateway already running pid=${lockResult.existing?.pid ?? '?'}`)
  }
  const lockHandle = lockResult.handle
  const lockRefresh = setInterval(() => {
    try {
      lockHandle.refreshFn()
    } catch {
      /* lock evicted; daemon will exit on next iteration */
    }
  }, 60 * 1000).unref()

  // Build harness session with stub bootstrap (never used in local mode —
  // /bootstrap/* routes are unreachable because session starts in Ready).
  const events = new EventHub()
  const approvals = new ApprovalRelay(events)
  const runtime = new RealRuntime({ approvals })
  const sandboxId = `local-${hostname()}-${agentId.slice(0, 8)}`
  const sess = createSession({
    bootstrap: generateBootstrapKeypair(),
    expectedOperatorAddress: operatorAddress,
    sandboxId,
    events,
    approvals,
    runtime,
    version: GATEWAY_VERSION,
  })

  // Provision inline: skip /bootstrap/provision HTTP roundtrip.
  transitionToProvisioned(sess, {
    agentPrivkey,
    agentAddress,
    operatorAddress,
    iNFTRef: { contract: contractAddress, tokenId: tokenId.toString() },
    config: config as unknown as Parameters<typeof transitionToProvisioned>[1]['config'],
  })

  const log = (line: string): void => {
    process.stdout.write(`[gateway] ${new Date().toISOString()} ${line}\n`)
  }

  // Start runtime async so we can bind the socket before brain.init resolves.
  // Server returns 409 on /chat until state === 'Ready'.
  void runtime
    .start({
      agentPrivkey,
      config: config as unknown as Parameters<typeof runtime.start>[0]['config'],
      events,
    })
    .then(() => {
      transitionToReady(sess)
      log(`runtime ready agent=${agentAddress}`)
    })
    .catch(err => {
      log(`runtime-start-error: ${(err as Error).message}`)
    })

  const server = createGatewayServer({ session: sess, logger: log, trustLocal: true })

  const socketPath = join(paths.dir, 'gateway.sock')
  // Clean stale socket from prior crash.
  try {
    unlinkSync(socketPath)
  } catch {
    /* ENOENT or similar; ignore */
  }
  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600)
    } catch {
      /* non-POSIX */
    }
    log(`listening unix:${socketPath} agent=${agentId}`)
    log('bootstrap pubkey=(skipped — local mode)')
    log(`expecting operator=${operatorAddress}`)
  })

  const shutdown = (signal: string): void => {
    log(`signal=${signal} shutting down`)
    transitionToShuttingDown(sess)
    clearInterval(lockRefresh)
    approvals.stop()
    Promise.resolve(runtime.stop()).catch(() => {})
    try {
      lockHandle.releaseFn()
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
    server.close(() => {
      log('server closed')
      process.exit(0)
    })
    setTimeout(() => {
      log('shutdown timeout, forcing exit')
      process.exit(1)
    }, 10_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch(err => {
  process.stderr.write(`gateway: fatal — ${(err as Error).message}\n`)
  process.exit(1)
})
