import type { Address, Hex } from 'viem'
import pkg from '../package.json' with { type: 'json' }
import type { ApprovalRelay } from './approval-relay'
import type { EventHub } from './events'
import type { RuntimeAdapter, RuntimeConfig } from './runtime'

// Derived from package.json so /healthz always reports the version that's
// actually running. Kept as a const so existing consumers (tests, server.ts)
// don't need to change. The JSON import attribute is supported by bun + tsc
// (TypeScript 5+) and produces a synchronous, type-safe import.
export const HARNESS_VERSION: string = (pkg as { version: string }).version

export type HarnessState = 'Bootstrapping' | 'Provisioned' | 'Ready' | 'ShuttingDown'

export interface INFTRef {
  contract: Address
  tokenId: string
}

export interface HarnessSession {
  state: HarnessState
  version: string
  sandboxId: string
  bootedAt: number
  provisionedAt: number | null
  readyAt: number | null

  bootstrap: {
    privkeyHex: Hex
    pubkeyHexCompressed: Hex
    pubkeyHexUncompressed: Hex
  }

  expectedOperatorAddress: Address

  agentPrivkey: Hex | null
  agentAddress: Address | null
  iNFTRef: INFTRef | null
  operatorAddress: Address | null
  config: RuntimeConfig | null

  events: EventHub
  approvals: ApprovalRelay
  runtime: RuntimeAdapter
}

export interface CreateSessionOpts {
  bootstrap: HarnessSession['bootstrap']
  expectedOperatorAddress: Address
  sandboxId: string
  events: EventHub
  approvals: ApprovalRelay
  runtime: RuntimeAdapter
  version?: string
}

export function createSession(opts: CreateSessionOpts): HarnessSession {
  return {
    state: 'Bootstrapping',
    version: opts.version ?? HARNESS_VERSION,
    sandboxId: opts.sandboxId,
    bootedAt: Date.now(),
    provisionedAt: null,
    readyAt: null,
    bootstrap: opts.bootstrap,
    expectedOperatorAddress: opts.expectedOperatorAddress,
    agentPrivkey: null,
    agentAddress: null,
    iNFTRef: null,
    operatorAddress: null,
    config: null,
    events: opts.events,
    approvals: opts.approvals,
    runtime: opts.runtime,
  }
}

export interface ProvisionInputs {
  agentPrivkey: Hex
  agentAddress: Address
  operatorAddress: Address
  iNFTRef: INFTRef
  config: RuntimeConfig
}

export function transitionToProvisioned(session: HarnessSession, inputs: ProvisionInputs): void {
  if (session.state !== 'Bootstrapping') {
    throw new Error(`cannot transition to Provisioned from state=${session.state}`)
  }
  session.agentPrivkey = inputs.agentPrivkey
  session.agentAddress = inputs.agentAddress
  session.operatorAddress = inputs.operatorAddress
  session.iNFTRef = inputs.iNFTRef
  session.config = inputs.config
  session.provisionedAt = Date.now()
  session.state = 'Provisioned'
  session.events.publish('state-change', { state: 'Provisioned' })
}

export function transitionToReady(session: HarnessSession): void {
  if (session.state !== 'Provisioned') {
    throw new Error(`cannot transition to Ready from state=${session.state}`)
  }
  session.readyAt = Date.now()
  session.state = 'Ready'
  session.events.publish('state-change', { state: 'Ready' })
}

export function transitionToShuttingDown(session: HarnessSession): void {
  session.state = 'ShuttingDown'
  session.events.publish('state-change', { state: 'ShuttingDown' })
}
