import { describe, expect, test } from 'bun:test'
import { generateBootstrapKeypair } from '@s0nderlabs/anima-core'
import { ApprovalRelay } from './approval-relay'
import { EventHub } from './events'
import type { RuntimeConfig } from './runtime'
import {
  GATEWAY_VERSION,
  createSession,
  transitionToProvisioned,
  transitionToReady,
  transitionToShuttingDown,
} from './state'
import { StubRuntime } from './stub-runtime'

import type { Address } from 'viem'

const FAKE_OPERATOR = '0xCCCCCCCCcccccccccccCCCCCcCCcccccccccccCCC' as Address
const FAKE_AGENT = '0x1111111111111111111111111111111111111111' as Address
const FAKE_INFT = '0x9e71d79f06f956d4d2666b5c93dafab721c84721' as Address
const FAKE_BRAIN_PROVIDER = '0x0000000000000000000000000000000000000111' as Address

const FAKE_CONFIG: RuntimeConfig = {
  network: '0g-mainnet',
  brain: { provider: FAKE_BRAIN_PROVIDER, model: 'glm-5' },
  identity: {
    iNFT: { contract: FAKE_INFT, tokenId: '6' },
    agent: FAKE_AGENT,
  },
}

function newSession() {
  const events = new EventHub()
  return createSession({
    bootstrap: generateBootstrapKeypair(),
    expectedOperatorAddress: FAKE_OPERATOR,
    sandboxId: 'sbx-test',
    events,
    approvals: new ApprovalRelay(events),
    runtime: new StubRuntime(),
  })
}

describe('state machine', () => {
  test('createSession → Bootstrapping with timestamps', () => {
    const s = newSession()
    expect(s.state).toBe('Bootstrapping')
    expect(s.version).toBe(GATEWAY_VERSION)
    expect(s.sandboxId).toBe('sbx-test')
    expect(s.bootedAt).toBeGreaterThan(0)
    expect(s.provisionedAt).toBeNull()
    expect(s.readyAt).toBeNull()
    expect(s.agentPrivkey).toBeNull()
    expect(s.agentAddress).toBeNull()
    expect(s.config).toBeNull()
  })

  test('Bootstrapping → Provisioned populates fields + emits state-change', () => {
    const s = newSession()
    transitionToProvisioned(s, {
      agentPrivkey: '0xaa'.padEnd(66, '0') as `0x${string}`,
      agentAddress: FAKE_AGENT,
      operatorAddress: FAKE_OPERATOR,
      iNFTRef: { contract: FAKE_INFT, tokenId: '6' },
      config: FAKE_CONFIG,
    })
    expect(s.state).toBe('Provisioned')
    expect(s.agentAddress).toBe(FAKE_AGENT)
    expect(s.operatorAddress).toBe(FAKE_OPERATOR)
    expect(s.iNFTRef?.tokenId).toBe('6')
    expect(s.config?.network).toBe('0g-mainnet')
    expect(s.provisionedAt).toBeGreaterThan(0)
    const events = s.events.buffer()
    expect(events.some(e => e.kind === 'state-change')).toBe(true)
  })

  test('Provisioned → Ready captures readyAt', () => {
    const s = newSession()
    transitionToProvisioned(s, {
      agentPrivkey: '0xaa'.padEnd(66, '0') as `0x${string}`,
      agentAddress: FAKE_AGENT,
      operatorAddress: FAKE_OPERATOR,
      iNFTRef: { contract: FAKE_INFT, tokenId: '6' },
      config: FAKE_CONFIG,
    })
    transitionToReady(s)
    expect(s.state).toBe('Ready')
    expect(s.readyAt).toBeGreaterThan(0)
  })

  test('cannot transition to Provisioned twice', () => {
    const s = newSession()
    const inputs = {
      agentPrivkey: '0xaa'.padEnd(66, '0') as `0x${string}`,
      agentAddress: FAKE_AGENT,
      operatorAddress: FAKE_OPERATOR,
      iNFTRef: { contract: FAKE_INFT, tokenId: '6' },
      config: FAKE_CONFIG,
    }
    transitionToProvisioned(s, inputs)
    expect(() => transitionToProvisioned(s, inputs)).toThrow(/cannot transition to Provisioned/)
  })

  test('cannot transition to Ready from Bootstrapping', () => {
    const s = newSession()
    expect(() => transitionToReady(s)).toThrow(/cannot transition to Ready/)
  })

  test('shutdown is reachable from any state', () => {
    const s = newSession()
    transitionToShuttingDown(s)
    expect(s.state).toBe('ShuttingDown')
  })
})
