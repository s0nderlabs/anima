#!/usr/bin/env bun
import { generateBootstrapKeypair } from '@s0nderlabs/anima-core'
import { type Address, getAddress } from 'viem'
import { ApprovalRelay } from './approval-relay'
import { EventHub } from './events'
import { startHeartbeat } from './heartbeat'
import { RealRuntime } from './real-runtime'
import { createGatewayServer } from './server'
import { GATEWAY_VERSION, createSession, transitionToShuttingDown } from './state'
import { StubRuntime } from './stub-runtime'

function envOrDie(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    console.error(`harness: ${name} env var required`)
    process.exit(1)
  }
  return v
}

const port = Number.parseInt(process.env.HARNESS_PORT ?? '8080', 10)
const host = process.env.HARNESS_HOST ?? '0.0.0.0'
const sandboxId = envOrDie('SANDBOX_ID')
const operatorAddrRaw = envOrDie('ANIMA_OPERATOR_ADDRESS')

let expectedOperatorAddress: Address
try {
  expectedOperatorAddress = getAddress(operatorAddrRaw)
} catch (e) {
  console.error(`harness: invalid ANIMA_OPERATOR_ADDRESS: ${(e as Error).message}`)
  process.exit(1)
}

const bootstrap = generateBootstrapKeypair()
const events = new EventHub()
const approvals = new ApprovalRelay(events)
// HARNESS_RUNTIME=stub falls back to StubRuntime (echo) for HTTP-bridge
// integration tests. Default = RealRuntime which constructs the full anima
// stack (brain + tools + plugins + listeners + sync) post-provision.
const runtime =
  process.env.HARNESS_RUNTIME === 'stub' ? new StubRuntime() : new RealRuntime({ approvals })

const session = createSession({
  bootstrap,
  expectedOperatorAddress,
  sandboxId,
  events,
  approvals,
  runtime,
  version: GATEWAY_VERSION,
})

const log = (line: string): void => {
  process.stdout.write(`[harness] ${new Date().toISOString()} ${line}\n`)
}

const server = createGatewayServer({ session, logger: log })

// Self-heartbeat keeps activity flowing through the public proxy so a healthy
// sandbox never looks idle to Daytona's auto-archive cron. Default 30 min;
// override via HARNESS_HEARTBEAT_INTERVAL_MS for canary compression.
const parsedHeartbeatMs = Number.parseInt(process.env.HARNESS_HEARTBEAT_INTERVAL_MS ?? '', 10)
const heartbeatIntervalMs =
  Number.isFinite(parsedHeartbeatMs) && parsedHeartbeatMs > 0 ? parsedHeartbeatMs : 30 * 60_000

let heartbeat: ReturnType<typeof startHeartbeat> | null = null

server.listen(port, host, () => {
  log(`listening ${host}:${port} sandboxId=${sandboxId}`)
  log(`bootstrap pubkey=${bootstrap.pubkeyHexCompressed}`)
  log(`expecting operator=${expectedOperatorAddress}`)
  log(`runtime=${runtime.constructor.name} (replace with real runtime in deploy bundle)`)
  // Start heartbeat AFTER listener is bound so the first tick (and any racy
  // canary-mode small-interval ticks) can't hit a not-yet-listening port.
  heartbeat = startHeartbeat({
    sandboxId,
    intervalMs: heartbeatIntervalMs,
    logger: log,
  })
  log(`heartbeat target=${heartbeat.targetUrl()} intervalMs=${heartbeatIntervalMs}`)
})

let shuttingDown = false
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  log(`signal=${signal} shutting down`)
  transitionToShuttingDown(session)
  heartbeat?.stop()
  approvals.stop()
  // Backstop in case runtime.stop hangs (e.g. grammy bot.stop deadlock).
  const forceExit = setTimeout(() => {
    log('shutdown timeout, forcing exit')
    process.exit(1)
  }, 10_000)
  forceExit.unref()
  // Plugin listeners (Telegram in particular) release their bot-token
  // scoped lock during runtime.stop teardown. If we exit before this
  // resolves, the next harness boot sees a stale lock with the dying PID
  // and silently refuses to start the listener (zombie-lock).
  try {
    await runtime.stop()
  } catch {
    /* best-effort */
  }
  server.close(() => {
    log('server closed')
    clearTimeout(forceExit)
    process.exit(0)
  })
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
