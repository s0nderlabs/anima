import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseEther } from 'viem'
import {
  closeLedger,
  getLedgerDetail,
  getLedgerDetailReadOnly,
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

// Stub RPC for getLedgerDetailReadOnly which goes ethers.Contract → eth_call.
// ethers v6 batches requests as an array, so the handler must answer each
// element by id with the right method shape.
function startStubRpc(returnHex: string | null): { url: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const raw = await req.json().catch(() => null)
      if (!raw) return new Response('bad-body', { status: 400 })
      const list = Array.isArray(raw) ? raw : [raw]
      const out = list.map((req: { id: number; method: string }) => {
        if (req.method === 'eth_chainId') {
          return { jsonrpc: '2.0', id: req.id, result: '0x4115' }
        }
        if (req.method === 'eth_call') {
          if (returnHex === null) {
            return {
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32000, message: 'execution reverted' },
            }
          }
          return { jsonrpc: '2.0', id: req.id, result: returnHex }
        }
        if (req.method === 'eth_blockNumber') {
          return { jsonrpc: '2.0', id: req.id, result: '0x1' }
        }
        return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'unsupported' } }
      })
      const body = Array.isArray(raw) ? out : out[0]
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { url: `http://localhost:${server.port}`, close: () => server.stop(true) }
}

describe('getLedgerDetailReadOnly', () => {
  const AGENT = '0x1e930c1647EaB93651FD94e760E0cbbb5F4FC99f' as const

  test('parses tuple return: (user, availableBalance, totalBalance, additionalInfo)', async () => {
    // Real specter response from May 7 2026 audit (each chunk is 64 hex / 32 bytes):
    // [0x20 offset, user, availableBalance=0x013569b66ac74000, totalBalance=0x05e9e4f97f7b5000, 0x80, 0]
    const pad = (h: string): string => h.padStart(64, '0')
    const returnHex = `0x${pad('20')}${pad('1e930c1647eab93651fd94e760e0cbbb5f4fc99f')}${pad('013569b66ac74000')}${pad('05e9e4f97f7b5000')}${pad('80')}${pad('0')}`
    const stub = startStubRpc(returnHex)
    try {
      const r = await getLedgerDetailReadOnly({
        network: '0g-mainnet',
        agentAddress: AGENT,
        rpcUrl: stub.url,
      })
      expect(r).not.toBeNull()
      expect(r?.availableBalance).toBe(0x013569b66ac74000n)
      expect(r?.totalBalance).toBe(0x05e9e4f97f7b5000n)
      expect(r?.lockedBalance).toBe(0x05e9e4f97f7b5000n - 0x013569b66ac74000n)
    } finally {
      stub.close()
    }
  })

  test('returns null on revert (ledger does not exist)', async () => {
    const stub = startStubRpc(null)
    try {
      const r = await getLedgerDetailReadOnly({
        network: '0g-mainnet',
        agentAddress: AGENT,
        rpcUrl: stub.url,
      })
      expect(r).toBeNull()
    } finally {
      stub.close()
    }
  })
})
