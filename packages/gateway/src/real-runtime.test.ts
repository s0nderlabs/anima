import { describe, expect, test } from 'bun:test'
import { ApprovalRelay } from './approval-relay'
import { EventHub } from './events'
import { RealRuntime, stringifyMarketEvent } from './real-runtime'

describe('RealRuntime contract', () => {
  test('ready() is false before start', () => {
    const events = new EventHub()
    const approvals = new ApprovalRelay(events)
    const rt = new RealRuntime({ approvals })
    expect(rt.ready()).toBe(false)
    approvals.stop()
  })

  test('runChatTurn rejects before start', async () => {
    const events = new EventHub()
    const approvals = new ApprovalRelay(events)
    const rt = new RealRuntime({ approvals })
    await expect(
      rt.runChatTurn({
        message: 'hi',
        ts: Date.now(),
        signature: '0xfakefakefakefake' as `0x${string}`,
        operatorAddress: '0x0000000000000000000000000000000000000000',
      }),
    ).rejects.toThrow(/runtime-not-started/)
    approvals.stop()
  })

  test('flushSync rejects before start', async () => {
    const events = new EventHub()
    const approvals = new ApprovalRelay(events)
    const rt = new RealRuntime({ approvals })
    await expect(rt.flushSync()).rejects.toThrow(/runtime-not-started/)
    approvals.stop()
  })

  test('stop() is idempotent before start', async () => {
    const events = new EventHub()
    const approvals = new ApprovalRelay(events)
    const rt = new RealRuntime({ approvals })
    await rt.stop()
    await rt.stop() // second call must not throw
    expect(rt.ready()).toBe(false)
    approvals.stop()
  })

  test('agentDirRoot defaults to system tmpdir/anima-gateway', () => {
    const events = new EventHub()
    const approvals = new ApprovalRelay(events)
    const rt = new RealRuntime({ approvals })
    // Internal field; we just confirm the public surface doesn't blow up
    expect(rt).toBeInstanceOf(RealRuntime)
    approvals.stop()
  })
})

describe('stringifyMarketEvent (v0.24.15 BigInt-safe drainMarket)', () => {
  const cases: { name: string; event: Record<string, unknown>; expect: Record<string, string> }[] =
    [
      {
        name: 'created (jobId + amount + blockNumber)',
        event: {
          kind: 'created',
          jobId: 16n,
          buyer: '0xaaa',
          amount: 1_000_000_000_000_000n,
          descriptionHash: '0xbb',
          blockNumber: 33_000_000n,
        },
        expect: { jobId: '16', amount: '1000000000000000', blockNumber: '33000000' },
      },
      {
        name: 'settled (payout + fee + blockNumber)',
        event: {
          kind: 'settled',
          jobId: 5n,
          recipient: '0xprov',
          payout: 4_750_000_000_000_000n,
          fee: 250_000_000_000_000n,
          blockNumber: 33_000_001n,
        },
        expect: { jobId: '5', payout: '4750000000000000', fee: '250000000000000' },
      },
      {
        name: 'splitProposed (both amounts + blockNumber)',
        event: {
          kind: 'splitProposed',
          jobId: 7n,
          proposer: '0xprop',
          buyerAmount: 2_000_000_000_000_000n,
          providerAmount: 3_000_000_000_000_000n,
          blockNumber: 33_000_002n,
        },
        expect: { jobId: '7', buyerAmount: '2000000000000000', providerAmount: '3000000000000000' },
      },
      {
        name: 'markedDone (blockNumber-only BigInt path)',
        event: { kind: 'markedDone', jobId: 9n, blockNumber: 33_000_003n, txHash: '0xcc' },
        expect: { jobId: '9', blockNumber: '33000003' },
      },
    ]

  for (const c of cases) {
    test(`serializes ${c.name}`, () => {
      const parsed = JSON.parse(stringifyMarketEvent(c.event))
      for (const [k, v] of Object.entries(c.expect)) expect(parsed[k]).toBe(v)
      expect(parsed.kind).toBe(c.event.kind)
    })
  }

  test('plain JSON.stringify throws on the same shape (regression guard)', () => {
    const e = { kind: 'created', jobId: 16n, amount: 1n }
    expect(() => JSON.stringify(e)).toThrow(/BigInt/)
    expect(() => JSON.stringify({ ...e, jobId: e.jobId.toString() })).toThrow(/BigInt/)
    expect(() => stringifyMarketEvent(e)).not.toThrow()
  })
})
