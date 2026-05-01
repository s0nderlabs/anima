#!/usr/bin/env bun
import { generateBootstrapKeypair } from '@s0nderlabs/anima-core'
import { type Address, getAddress } from 'viem'
import { ApprovalRelay } from './approval-relay'
import { EventHub } from './events'
import { RealRuntime } from './real-runtime'
import { createHarnessServer } from './server'
import { HARNESS_VERSION, createSession, transitionToShuttingDown } from './state'
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
  version: HARNESS_VERSION,
})

const log = (line: string): void => {
  process.stdout.write(`[harness] ${new Date().toISOString()} ${line}\n`)
}

const server = createHarnessServer({ session, logger: log })

server.listen(port, host, () => {
  log(`listening ${host}:${port} sandboxId=${sandboxId}`)
  log(`bootstrap pubkey=${bootstrap.pubkeyHexCompressed}`)
  log(`expecting operator=${expectedOperatorAddress}`)
  log(`runtime=${runtime.constructor.name} (replace with real runtime in deploy bundle)`)
})

const shutdown = (signal: string): void => {
  log(`signal=${signal} shutting down`)
  transitionToShuttingDown(session)
  approvals.stop()
  Promise.resolve(runtime.stop()).catch(() => {})
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
