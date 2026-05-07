import { describe, expect, test } from 'bun:test'
import type { PublicClient, WalletClient } from 'viem'
import type { OnchainRuntimeContext } from '../types'
import { makeAccountBalance } from './account-balance'

// Minimal viem PublicClient shim — only the calls account.balance touches.
function fakeClient(returnWei: bigint): Partial<PublicClient> {
  return {
    getBalance: async () => returnWei,
  } as Partial<PublicClient>
}

function makeCtx(overrides: Partial<OnchainRuntimeContext> = {}): OnchainRuntimeContext {
  return {
    agentEoa: '0x1e930c1647EaB93651FD94e760E0cbbb5F4FC99f',
    network: '0g-mainnet',
    publicClient: fakeClient(1_158n * 10n ** 15n) as PublicClient,
    walletClient: {} as WalletClient,
    agentDir: '/tmp/anima-test-agent',
    mintBlock: 0n,
    ...overrides,
  }
}

describe('account.balance brain tool', () => {
  test('returns EOA mainnet balance even when ledger + testnet RPC unreachable', async () => {
    const tool = makeAccountBalance(makeCtx())
    const result = await tool.handler({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as { eoaMainnet: { formatted: string } }
    expect(data.eoaMainnet.formatted).toBe('1.158000')
  })

  test('skips sandboxBillingReserve when deployTarget=local', async () => {
    const tool = makeAccountBalance(makeCtx({ deployTarget: 'local' }))
    const result = await tool.handler({})
    if (!result.ok) throw new Error(`unexpected fail: ${result.error}`)
    const data = result.data as { sandboxBillingReserve: unknown }
    expect(data.sandboxBillingReserve).toBeNull()
  })

  test('skips sandboxBillingReserve when operatorAddress missing even under sandbox', async () => {
    const tool = makeAccountBalance(makeCtx({ deployTarget: 'sandbox' }))
    const result = await tool.handler({})
    if (!result.ok) throw new Error(`unexpected fail: ${result.error}`)
    const data = result.data as { sandboxBillingReserve: unknown }
    expect(data.sandboxBillingReserve).toBeNull()
  })

  test('tool description mentions full picture cues so brain picks it for "balance" intent', () => {
    const tool = makeAccountBalance(makeCtx())
    expect(tool.description).toMatch(/full balance position|EOA|compute ledger/i)
    expect(tool.searchHint).toMatch(/balance|ledger/)
  })

  test('formatted helper preserves 6 decimals + handles small values', async () => {
    // 0.000001 0G = 10^12 wei, should render as "0.000001"
    const tool = makeAccountBalance(
      makeCtx({ publicClient: fakeClient(10n ** 12n) as PublicClient }),
    )
    const result = await tool.handler({})
    if (!result.ok) throw new Error(`unexpected fail: ${result.error}`)
    const data = result.data as { eoaMainnet: { formatted: string } }
    expect(data.eoaMainnet.formatted).toBe('0.000001')
  })
})
