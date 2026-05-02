import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseEther } from 'viem'
import {
  closeLedger,
  getLedgerDetail,
  refundFromLedger,
  retrieveLedgerFunds,
  setBrokerFactoryForTests,
} from './ledger'

const PRIVKEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`
const PROVIDER = '0x992e6396157Dc4f22E74F2231235D7DE62696db5'

interface Calls {
  refund: number[]
  retrieve: string[]
  delete: number
}

function makeMockBroker(opts: {
  ledger?: { totalBalance: bigint; availableBalance: bigint } | 'missing'
  providers?: [string, bigint, bigint][]
  providersThrows?: boolean
  calls: Calls
}) {
  return async () => {
    return {
      ledger: {
        getLedger: async () => {
          if (opts.ledger === 'missing') throw new Error('LedgerNotExists')
          if (!opts.ledger) throw new Error('no ledger configured for test')
          return opts.ledger
        },
        getProvidersWithBalance: async (svc: string) => {
          if (opts.providersThrows) throw new Error('providers boom')
          if (svc !== 'inference') throw new Error(`expected inference but got ${svc}`)
          return opts.providers ?? []
        },
        refund: async (amount: number) => {
          opts.calls.refund.push(amount)
        },
        retrieveFund: async (svc: string) => {
          opts.calls.retrieve.push(svc)
        },
        deleteLedger: async () => {
          opts.calls.delete += 1
        },
      },
    } as unknown as Awaited<
      ReturnType<typeof import('@0glabs/0g-serving-broker').createZGComputeNetworkBroker>
    >
  }
}

describe('ledger helpers (broker injected)', () => {
  let calls: Calls
  beforeEach(() => {
    calls = { refund: [], retrieve: [], delete: 0 }
  })
  afterEach(() => {
    setBrokerFactoryForTests(null)
  })

  test('getLedgerDetail returns null when no ledger exists', async () => {
    setBrokerFactoryForTests(makeMockBroker({ ledger: 'missing', calls }))
    const r = await getLedgerDetail({ network: '0g-mainnet', privkeyHex: PRIVKEY })
    expect(r).toBeNull()
  })

  test('getLedgerDetail returns balance + provider list', async () => {
    setBrokerFactoryForTests(
      makeMockBroker({
        ledger: { totalBalance: parseEther('3'), availableBalance: parseEther('2.5') },
        providers: [[PROVIDER, parseEther('1'), parseEther('0.5')]],
        calls,
      }),
    )
    const r = await getLedgerDetail({ network: '0g-mainnet', privkeyHex: PRIVKEY })
    expect(r).not.toBeNull()
    expect(r?.totalBalance).toBe(parseEther('3'))
    expect(r?.availableBalance).toBe(parseEther('2.5'))
    expect(r?.inferenceProviders).toEqual([
      { provider: PROVIDER, balance: parseEther('1'), pendingRefund: parseEther('0.5') },
    ])
  })

  test('getLedgerDetail tolerates getProvidersWithBalance throwing (no providers acked)', async () => {
    setBrokerFactoryForTests(
      makeMockBroker({
        ledger: { totalBalance: parseEther('3'), availableBalance: parseEther('3') },
        providersThrows: true,
        calls,
      }),
    )
    const r = await getLedgerDetail({ network: '0g-mainnet', privkeyHex: PRIVKEY })
    expect(r?.inferenceProviders).toEqual([])
    expect(r?.totalBalance).toBe(parseEther('3'))
  })

  test('refundFromLedger calls broker.ledger.refund with passed amount', async () => {
    setBrokerFactoryForTests(
      makeMockBroker({
        ledger: { totalBalance: parseEther('3'), availableBalance: parseEther('3') },
        calls,
      }),
    )
    await refundFromLedger({ network: '0g-mainnet', privkeyHex: PRIVKEY, amount: 1.5 })
    expect(calls.refund).toEqual([1.5])
  })

  test('retrieveLedgerFunds calls retrieveFund("inference")', async () => {
    setBrokerFactoryForTests(
      makeMockBroker({
        ledger: { totalBalance: parseEther('3'), availableBalance: parseEther('3') },
        calls,
      }),
    )
    await retrieveLedgerFunds({ network: '0g-mainnet', privkeyHex: PRIVKEY })
    expect(calls.retrieve).toEqual(['inference'])
  })

  test('closeLedger calls deleteLedger', async () => {
    setBrokerFactoryForTests(
      makeMockBroker({
        ledger: { totalBalance: parseEther('3'), availableBalance: parseEther('3') },
        calls,
      }),
    )
    await closeLedger({ network: '0g-mainnet', privkeyHex: PRIVKEY })
    expect(calls.delete).toBe(1)
  })
})
