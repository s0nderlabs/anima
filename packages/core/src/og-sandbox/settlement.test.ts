import { describe, expect, test } from 'bun:test'
import {
  SANDBOX_PROVIDER_GALILEO,
  SANDBOX_SETTLEMENT_GALILEO,
  getSandboxBillingReserve,
} from './index'

// Stub HTTP server that mimics a Galileo RPC endpoint and returns a chosen
// uint256 from `eth_call`. Used to keep the tests offline and deterministic.
function startStubRpc(returnHex: string | null): { url: string; close: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => null)) as { method?: string } | null
      if (body?.method === 'eth_chainId') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x40da' }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (body?.method === 'eth_call') {
        if (returnHex === null) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32000, message: 'execution reverted' },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: returnHex }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not-found', { status: 404 })
    },
  })
  return { url: `http://localhost:${server.port}`, close: () => server.stop(true) }
}

describe('getSandboxBillingReserve', () => {
  test('returns parsed bigint when chain returns balance', async () => {
    // 1.613 0G = 1613000000000000000 wei = 0x166286f436b93d98 padded to 32 bytes
    const stub = startStubRpc('0x000000000000000000000000000000000000000000000000166286f436b93d98')
    try {
      const r = await getSandboxBillingReserve({
        recipient: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
        rpcUrl: stub.url,
      })
      expect(r).toBe(0x166286f436b93d98n)
    } finally {
      stub.close()
    }
  })

  test('returns 0n on revert (recipient never deposited)', async () => {
    const stub = startStubRpc(null)
    try {
      const r = await getSandboxBillingReserve({
        recipient: '0x0000000000000000000000000000000000000001',
        rpcUrl: stub.url,
      })
      expect(r).toBe(0n)
    } finally {
      stub.close()
    }
  })

  test('default provider is the canonical Galileo Daytona address', () => {
    expect(SANDBOX_PROVIDER_GALILEO).toBe('0xB831371eb2703305f1d9F8542163633D0675CEd7')
    expect(SANDBOX_SETTLEMENT_GALILEO).toBe('0xd7e0CD227e602FedBb93c36B1F5bf415398508a4')
  })
})
