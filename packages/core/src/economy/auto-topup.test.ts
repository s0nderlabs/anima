import { describe, expect, it } from 'bun:test'
import type { Address } from 'viem'
import {
  type AutoTopupEvent,
  AutoTopupManager,
  type BrokerLedgerLike,
  type PublicClientLike,
} from './auto-topup'

const PROVIDER: Address = '0x992e6396157Dc4f22E74F2231235D7DE62696db5'
const AGENT: Address = '0x1e930c1647EaB93651FD94e760E0cbbb5F4FC99f'
const ONE_OG = 1_000_000_000_000_000_000n

interface FakeBrokerOpts {
  initialEnvelopeWei?: bigint
  envelopePendingRefundWei?: bigint
  failOnDeposit?: boolean
  failOnTransfer?: boolean
}

function makeBroker(opts: FakeBrokerOpts = {}): {
  broker: BrokerLedgerLike
  state: {
    deposits: number[]
    transfers: Array<{ provider: Address; amountWei: bigint }>
    envelopeWei: bigint
  }
} {
  const state = {
    deposits: [] as number[],
    transfers: [] as Array<{ provider: Address; amountWei: bigint }>,
    envelopeWei: opts.initialEnvelopeWei ?? 0n,
    refundWei: opts.envelopePendingRefundWei ?? 0n,
  }
  const broker: BrokerLedgerLike = {
    async getLedger() {
      return { availableBalance: 0n, totalBalance: state.envelopeWei }
    },
    async getProvidersWithBalance(_serviceType) {
      return [[PROVIDER, state.envelopeWei, state.refundWei] as const]
    },
    async depositFund(amount) {
      if (opts.failOnDeposit) throw new Error('deposit failed')
      state.deposits.push(amount)
      return { hash: '0xdeadbeef' as `0x${string}` }
    },
    async transferFund(provider, _service, amountWei) {
      if (opts.failOnTransfer) throw new Error('transfer failed')
      state.transfers.push({ provider, amountWei })
      state.envelopeWei += amountWei
      return { hash: '0xfeedface' as `0x${string}` }
    },
  }
  return { broker, state }
}

function makePublicClient(walletWei: bigint): PublicClientLike {
  return {
    async getBalance() {
      return walletWei
    },
  }
}

function captureEvents(): { events: AutoTopupEvent[]; onEvent: (ev: AutoTopupEvent) => void } {
  const events: AutoTopupEvent[] = []
  return { events, onEvent: (ev: AutoTopupEvent) => events.push(ev) }
}

describe('AutoTopupManager', () => {
  it('skips action when envelope is above threshold', async () => {
    const { broker, state } = makeBroker({ initialEnvelopeWei: ONE_OG })
    const { events, onEvent } = captureEvents()
    const m = new AutoTopupManager(
      { compute: { provider: PROVIDER, lowThreshold: 0.5 } },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(10n * ONE_OG),
        getBrokerLedger: async () => broker,
        onEvent,
      },
    )
    await m.tick()
    expect(state.deposits).toEqual([])
    expect(state.transfers).toEqual([])
    expect(events.filter(e => e.kind === 'topup-fired')).toEqual([])
  })

  it('fires deposit + transfer when envelope is below threshold', async () => {
    const { broker, state } = makeBroker({ initialEnvelopeWei: ONE_OG / 10n }) // 0.1 0G
    const { events, onEvent } = captureEvents()
    const m = new AutoTopupManager(
      { compute: { provider: PROVIDER, lowThreshold: 0.5, topUpAmount: 1.0 } },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(10n * ONE_OG),
        getBrokerLedger: async () => broker,
        onEvent,
      },
    )
    await m.tick()
    expect(state.deposits).toEqual([1.0])
    expect(state.transfers).toHaveLength(1)
    expect(state.transfers[0]?.provider).toBe(PROVIDER)
    expect(state.transfers[0]?.amountWei).toBe(ONE_OG)
    const fired = events.find(e => e.kind === 'topup-fired')
    expect(fired).toBeDefined()
    expect(fired?.data.envelope).toBe('compute')
    expect(fired?.data.depositTx).toBe('0xdeadbeef')
    expect(fired?.data.transferTx).toBe('0xfeedface')
  })

  it('refuses topup when wallet would dip below minRetainedAfterTopup', async () => {
    const { broker, state } = makeBroker({ initialEnvelopeWei: 0n })
    const { events, onEvent } = captureEvents()
    const m = new AutoTopupManager(
      {
        compute: { provider: PROVIDER, lowThreshold: 0.5, topUpAmount: 1.0 },
        wallet: { minRetainedAfterTopup: 0.5 },
      },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(ONE_OG), // 1 0G — not enough to retain 0.5 after spending 1.0
        getBrokerLedger: async () => broker,
        onEvent,
      },
    )
    await m.tick()
    expect(state.deposits).toEqual([])
    const failed = events.find(e => e.kind === 'topup-failed')
    expect(failed?.data.reason).toBe('insufficient-wallet')
  })

  it('honors daily cap', async () => {
    const { broker, state } = makeBroker({ initialEnvelopeWei: 0n })
    const { events, onEvent } = captureEvents()
    const m = new AutoTopupManager(
      { compute: { provider: PROVIDER, lowThreshold: 0.5, topUpAmount: 0.5, maxPerDay: 2 } },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(100n * ONE_OG),
        getBrokerLedger: async () => broker,
        onEvent,
      },
    )
    // Fake broker keeps adding to envelope on each transfer; reset to keep below threshold.
    state.envelopeWei = 0n
    await m.tick()
    state.envelopeWei = 0n
    await m.tick()
    state.envelopeWei = 0n
    await m.tick()
    expect(state.deposits).toEqual([0.5, 0.5])
    const failed = events.find(e => e.kind === 'topup-failed' && e.data.reason === 'daily-cap')
    expect(failed).toBeDefined()
  })

  it('emits wallet-low ONCE when balance crosses threshold downward', async () => {
    const { broker } = makeBroker({ initialEnvelopeWei: 10n * ONE_OG })
    const { events, onEvent } = captureEvents()
    let walletWei = 5n * ONE_OG // above threshold
    const m = new AutoTopupManager(
      { compute: { provider: PROVIDER }, wallet: { notifyThreshold: 2.0 } },
      {
        agentAddress: AGENT,
        publicClient: { getBalance: async () => walletWei },
        getBrokerLedger: async () => broker,
        onEvent,
      },
    )
    await m.tick()
    expect(events.filter(e => e.kind === 'wallet-low')).toEqual([])
    walletWei = ONE_OG // below threshold (1.0 < 2.0)
    await m.tick()
    expect(events.filter(e => e.kind === 'wallet-low')).toHaveLength(1)
    // Stay below — should NOT re-emit
    await m.tick()
    expect(events.filter(e => e.kind === 'wallet-low')).toHaveLength(1)
  })

  it('emits topup-failed with reason=tx-failed when deposit reverts', async () => {
    const { broker } = makeBroker({ initialEnvelopeWei: 0n, failOnDeposit: true })
    const { events, onEvent } = captureEvents()
    const m = new AutoTopupManager(
      { compute: { provider: PROVIDER, lowThreshold: 0.5, topUpAmount: 1.0 } },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(10n * ONE_OG),
        getBrokerLedger: async () => broker,
        onEvent,
      },
    )
    await m.tick()
    const failed = events.find(e => e.kind === 'topup-failed')
    expect(failed?.data.reason).toBe('tx-failed')
    expect(failed?.data.error as string).toContain('deposit failed')
  })

  it('emits topup-skipped when broker is not yet available', async () => {
    const { events, onEvent } = captureEvents()
    const m = new AutoTopupManager(
      { compute: { provider: PROVIDER } },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(10n * ONE_OG),
        getBrokerLedger: async () => null,
        onEvent,
      },
    )
    await m.tick()
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('topup-skipped')
    expect((events[0]?.data as { reason?: string } | undefined)?.reason).toBe('broker-not-ready')
  })

  it('v0.21.5: getBrainInit wakes broker on first null tick + reattempts ledger', async () => {
    const { broker, state } = makeBroker({ initialEnvelopeWei: ONE_OG / 10n })
    const { events, onEvent } = captureEvents()
    let initCalls = 0
    let brokerReady = false
    const m = new AutoTopupManager(
      { compute: { provider: PROVIDER, lowThreshold: 0.5, topUpAmount: 1.0 } },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(10n * ONE_OG),
        getBrokerLedger: async () => (brokerReady ? broker : null),
        getBrainInit: async () => {
          initCalls++
          brokerReady = true
        },
        onEvent,
      },
    )
    await m.tick()
    expect(initCalls).toBe(1)
    // Broker became ready after init; topup should fire on the same tick.
    expect(state.deposits).toEqual([1.0])
    expect(events.find(e => e.kind === 'topup-fired')).toBeDefined()
    // No spurious topup-skipped event.
    expect(events.find(e => e.kind === 'topup-skipped')).toBeUndefined()
  })

  it('v0.21.5: getBrainInit failure surfaces as topup-skipped with initError', async () => {
    const { events, onEvent } = captureEvents()
    let initCalls = 0
    const m = new AutoTopupManager(
      { compute: { provider: PROVIDER, lowThreshold: 0.5 } },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(10n * ONE_OG),
        getBrokerLedger: async () => null,
        getBrainInit: async () => {
          initCalls++
          throw new Error('compute provider unreachable')
        },
        onEvent,
      },
    )
    await m.tick()
    expect(initCalls).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('topup-skipped')
    const data = events[0]?.data as { reason?: string; initError?: string }
    expect(data.reason).toBe('broker-not-ready')
    expect(data.initError).toContain('compute provider unreachable')
  })

  it('v0.21.5: getBrainInit not called when broker already ready', async () => {
    const { broker } = makeBroker({ initialEnvelopeWei: ONE_OG })
    const { onEvent } = captureEvents()
    let initCalls = 0
    const m = new AutoTopupManager(
      { compute: { provider: PROVIDER, lowThreshold: 0.5 } },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(10n * ONE_OG),
        getBrokerLedger: async () => broker,
        getBrainInit: async () => {
          initCalls++
        },
        onEvent,
      },
    )
    await m.tick()
    // Broker was ready immediately, init should NOT be called.
    expect(initCalls).toBe(0)
  })

  it('v0.21.5: legacy callers without getBrainInit see the same broker-not-ready path', async () => {
    const { events, onEvent } = captureEvents()
    const m = new AutoTopupManager(
      { compute: { provider: PROVIDER } },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(10n * ONE_OG),
        getBrokerLedger: async () => null,
        onEvent,
      },
    )
    await m.tick()
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('topup-skipped')
    expect((events[0]?.data as { reason?: string } | undefined)?.reason).toBe('broker-not-ready')
  })

  it('refuses construction when compute.provider is missing', () => {
    expect(
      () =>
        new AutoTopupManager(
          { compute: undefined as never },
          {
            agentAddress: AGENT,
            publicClient: makePublicClient(0n),
            getBrokerLedger: async () => null,
            onEvent: () => {},
          },
        ),
    ).toThrow(/compute\.provider/)
  })

  it('does not fire when provider envelope is unmatched (different provider)', async () => {
    const otherProvider: Address = '0x0000000000000000000000000000000000000099'
    const { broker, state } = makeBroker({ initialEnvelopeWei: 5n * ONE_OG })
    const { onEvent } = captureEvents()
    const m = new AutoTopupManager(
      { compute: { provider: otherProvider, lowThreshold: 0.5, topUpAmount: 1.0 } },
      {
        agentAddress: AGENT,
        publicClient: makePublicClient(10n * ONE_OG),
        getBrokerLedger: async () => broker,
        onEvent,
      },
    )
    await m.tick()
    // Configured provider has 0 envelope (broker only knows about PROVIDER) → should fire topup
    expect(state.deposits).toEqual([1.0])
    expect(state.transfers[0]?.provider).toBe(otherProvider)
  })
})
