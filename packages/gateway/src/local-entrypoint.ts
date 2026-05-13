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
  OPERATOR_BLOB_SCOPES,
  acquireScopedLock,
  agentPaths,
  decodeKeystoreBytes,
  decodeOperatorBlobBytes,
  decryptAgentKey,
  decryptOperatorBlob,
  generateBootstrapKeypair,
  getSessionKey,
  iNFTAgentId,
  readOperatorSession,
} from '@s0nderlabs/anima-core'
import { type Address, type Hex, getAddress, isAddress } from 'viem'
import { ApprovalRelay } from './approval-relay'
import { EventHub } from './events'
import { RealRuntime } from './real-runtime'
import type { GatewaySecrets } from './secrets'
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
  /** Optional .0g subname (forwarded into RuntimeConfig.subname so the TG
   * pairing greeting can address the agent by its registered name). */
  subname?: string | null
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

interface TelegramSecretsPlaintext {
  botToken: string
  botUsername?: string
  botId?: number
  allowedUserIds: number[]
}

async function loadLocalTelegramSecrets(opts: {
  agentId: string
  agentAddress: Address
}): Promise<GatewaySecrets | undefined> {
  const path = join(agentPaths.agent(opts.agentId).dir, 'telegram-secrets.encrypted')
  if (!existsSync(path)) return undefined
  const blobKey = getSessionKey(opts.agentId, OPERATOR_BLOB_SCOPES.TELEGRAM)
  if (!blobKey) {
    // v0.21.12: fail loud. Pre-fix this path returned undefined silently and
    // the daemon booted with a half-configured runtime: telegram-secrets.encrypted
    // existed on disk but the listener never started, so all inbound TG was
    // dropped. Operators only noticed when a phone message went unanswered —
    // sometimes hours later. Now we exit 1 BEFORE the socket binds so the
    // parent CLI's wait-for-socket-readable check fails, the operator sees
    // the failure at boot, and `anima gateway start` returns non-zero.
    die(
      'telegram secrets present but no telegram scope key in operator session — re-run `anima gateway start` to derive scope keys via Touch ID',
    )
  }
  try {
    const fileBytes = await readFile(path)
    const blob = decodeOperatorBlobBytes(new Uint8Array(fileBytes))
    const ptBytes = await decryptOperatorBlob({
      scope: OPERATOR_BLOB_SCOPES.TELEGRAM,
      agentAddress: opts.agentAddress,
      blob,
      precomputedKey: blobKey,
    })
    const parsed = JSON.parse(new TextDecoder().decode(ptBytes)) as TelegramSecretsPlaintext
    if (typeof parsed.botToken !== 'string' || !Array.isArray(parsed.allowedUserIds)) {
      throw new Error('malformed plaintext (missing botToken or allowedUserIds)')
    }
    return {
      telegram: {
        botToken: parsed.botToken,
        allowedUserIds: parsed.allowedUserIds,
      },
    }
  } catch (err) {
    process.stderr.write(`gateway: failed to load telegram secrets: ${(err as Error).message}\n`)
    return undefined
  }
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

  // Load encrypted telegram secrets (if any) using the cached telegram scope
  // key. Same shape `loadTelegramSecrets` (CLI util) produces — we inline the
  // decrypt path to avoid pulling the CLI signer into the daemon.
  const tgSecrets: GatewaySecrets | undefined = await loadLocalTelegramSecrets({
    agentId,
    agentAddress,
  })
  // v0.23.0: pull the PROFILE scope key from the cached operator session so
  // the daemon can flush profile.md every turn + restore the slot at boot.
  // When missing (older sessions, or operator never unlocked PROFILE), the
  // daemon boots without a key and profile slot stays in `no-profile-key`
  // skipped state until `anima profile init` sends one via /admin/profile-key.
  const profileKeyBuf = getSessionKey(agentId, OPERATOR_BLOB_SCOPES.PROFILE)
  const profileScopeKeyHex: `0x${string}` | undefined = profileKeyBuf
    ? (`0x${profileKeyBuf.toString('hex')}` as `0x${string}`)
    : undefined
  const secrets: GatewaySecrets | undefined =
    profileScopeKeyHex || tgSecrets
      ? {
          ...(tgSecrets ?? {}),
          ...(profileScopeKeyHex ? { profileScopeKeyHex } : {}),
        }
      : undefined

  // v0.21.5: proactively reap a zombie/crashed listener's bot-token lock so
  // TelegramListener.start() doesn't get stuck in scheduleStartRetry's 30s ×
  // 12-attempt waltz waiting for TTL eviction. Identity hash matches what
  // acquireTelegramTokenLock will compute (`${agentId}:${botToken}`). Skips
  // entirely when no telegram secrets present.
  if (secrets?.telegram?.botToken) {
    try {
      const { clearStaleTelegramTokenLock } = await import('@s0nderlabs/anima-plugin-telegram')
      const cleanup = clearStaleTelegramTokenLock(secrets.telegram.botToken, { agentId })
      if (cleanup.cleared) {
        process.stdout.write(
          `[gateway] ${new Date().toISOString()} cleared stale TG bot-token lock (${cleanup.reason})\n`,
        )
      }
    } catch (err) {
      // Best-effort: failure here doesn't block boot; listener will fall back
      // to scheduleStartRetry and emit BotTokenLockedError visibly.
      process.stderr.write(
        `gateway: stale-tg-lock-cleanup failed: ${(err as Error).message?.slice(0, 200) ?? 'unknown'}\n`,
      )
    }
  }

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
      secrets,
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

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log(`signal=${signal} shutting down`)
    transitionToShuttingDown(sess)
    clearInterval(lockRefresh)
    approvals.stop()
    // Backstop in case runtime.stop hangs (e.g. grammy bot.stop deadlock).
    const forceExit = setTimeout(() => {
      log('shutdown timeout, forcing exit')
      process.exit(1)
    }, 10_000)
    forceExit.unref()
    // Plugin listeners (Telegram especially) release their bot-token lock
    // during runtime.stop teardown. Exiting before this resolves leaves a
    // stale lock with the dying PID; the next boot then sees kill(pid, 0)
    // succeed against the zombie and silently refuses to start the
    // listener. See feedback-tg-token-lock-zombie-after-upgrade.md.
    try {
      await runtime.stop()
    } catch {
      /* best-effort */
    }
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
      clearTimeout(forceExit)
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch(err => {
  process.stderr.write(`gateway: fatal — ${(err as Error).message}\n`)
  process.exit(1)
})
