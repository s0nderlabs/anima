import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Address } from 'viem'
import type { OnchainRuntimeContext } from '../types'
import { makeAccountInfo } from './account'

function buildClient(blockNumber: bigint) {
  // Multicall returns >=1 entry (native balance is always [0]). Encode 0n as
  // padded uint256 hex so decodeFunctionResult on getEthBalance succeeds.
  const zeroBalance = `0x${'0'.repeat(64)}` as const
  return {
    getBlockNumber: async () => blockNumber,
    getLogs: async () => [],
    readContract: async () => [{ success: true, returnData: zeroBalance }],
  } as unknown as import('viem').PublicClient
}

function buildCtx(overrides: Partial<OnchainRuntimeContext> = {}): OnchainRuntimeContext {
  const dir = mkdtempSync(join(tmpdir(), 'anima-account-info-test-'))
  return {
    agentEoa: '0xd56bF6116815B18eEA696A8EBCDb7Bab427e9683' as Address,
    network: '0g-mainnet',
    publicClient: buildClient(32_300_000n),
    walletClient: {} as import('viem').WalletClient,
    agentDir: dir,
    mintBlock: 0n,
    iNFT: {
      contract: '0x9e71d79f06f956d4d2666b5c93dafab721c84721' as Address,
      tokenId: 6n,
    },
    brainProvider: '0x992e6396157Dc4f22E74F2231235D7DE62696db5',
    brainModel: 'qwen3.6-plus',
    ...overrides,
  }
}

describe('account.info return shape', () => {
  test('surfaces subname / pubkey / singletons when ctx provides them', async () => {
    const ctx = buildCtx({
      subname: 'enigma',
      agentPubkey: 'a'.repeat(128),
      singletons: {
        inbox: '0xcd92844cc0ec6Be0607B330D4BaCC707339f2589' as Address,
        market: '0x3ebD21f5dd67acDeF199fACF28388627212bA2aB' as Address,
        agentNFT: '0x9e71d79f06f956d4d2666b5c93dafab721c84721' as Address,
      },
    })
    const tool = makeAccountInfo(ctx)
    const res = await tool.handler({})
    if (!res.ok) console.error('account.info returned error:', res.error)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const data = res.data as {
      subname: string | null
      pubkey: string | null
      singletons: { inbox: Address; market: Address; agentNFT: Address } | null
      agentEoa: Address
    }
    expect(data.subname).toBe('enigma')
    expect(data.pubkey).toBe('a'.repeat(128))
    expect(data.singletons?.inbox.toLowerCase()).toBe('0xcd92844cc0ec6be0607b330d4bacc707339f2589')
    expect(data.singletons?.market.toLowerCase()).toBe('0x3ebd21f5dd67acdef199facf28388627212ba2ab')
    expect(data.singletons?.agentNFT.toLowerCase()).toBe(
      '0x9e71d79f06f956d4d2666b5c93dafab721c84721',
    )
  })

  test('falls back to null when ctx omits new fields (no crash)', async () => {
    const ctx = buildCtx() // no subname / pubkey / singletons
    const tool = makeAccountInfo(ctx)
    const res = await tool.handler({})
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const data = res.data as {
      subname: string | null
      pubkey: string | null
      singletons: unknown
    }
    expect(data.subname).toBeNull()
    expect(data.pubkey).toBeNull()
    expect(data.singletons).toBeNull()
  })
})
