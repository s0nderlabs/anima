import { describe, expect, test } from 'bun:test'
import { parseEther } from 'viem'
import { SWEEP_GAS_LIMIT, computeSweepAmount } from './drain'

const AGENT = '0x0000000000000000000000000000000000000001' as `0x${string}`

describe('computeSweepAmount', () => {
  test('subtracts default gas reserve from balance when comfortable', () => {
    const gasPrice = 4_000_000_000n
    const balance = parseEther('0.1')
    const r = computeSweepAmount({ balance, gasPrice, agentAddress: AGENT })
    expect(r.error).toBeUndefined()
    expect(r.gasReserve).toBe(SWEEP_GAS_LIMIT * gasPrice)
    expect(r.value).toBe(balance - SWEEP_GAS_LIMIT * gasPrice)
  })

  test('returns error string when balance below reserve', () => {
    const gasPrice = 4_000_000_000n
    const balance = SWEEP_GAS_LIMIT * gasPrice
    const r = computeSweepAmount({ balance, gasPrice, agentAddress: AGENT })
    expect(r.value).toBe(0n)
    expect(r.error).toContain('below gas reserve')
  })

  test('honors gasReserveOverride', () => {
    const gasPrice = 4_000_000_000n
    const balance = parseEther('1')
    const override = parseEther('0.005')
    const r = computeSweepAmount({
      balance,
      gasPrice,
      agentAddress: AGENT,
      gasReserveOverride: override,
    })
    expect(r.gasReserve).toBe(override)
    expect(r.value).toBe(balance - override)
  })

  test('error wording surfaces the agent address + balance + reserve', () => {
    const gasPrice = 4_000_000_000n
    const r = computeSweepAmount({ balance: 0n, gasPrice, agentAddress: AGENT })
    expect(r.error).toContain(AGENT)
    expect(r.error).toContain('0 0G')
  })
})
