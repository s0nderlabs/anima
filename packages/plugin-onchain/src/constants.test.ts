import { describe, expect, test } from 'bun:test'
import {
  FEE_TIERS,
  GIMO_BY_NETWORK,
  JAINE_BY_NETWORK,
  MIN_STAKE_WEI,
  MULTICALL3,
  requireMainnet,
} from './constants'

describe('mainnet addresses (verified May 1 2026)', () => {
  test('JAINE addresses match phase-10-design-locked.md', () => {
    const jaine = JAINE_BY_NETWORK['0g-mainnet']!
    expect(jaine.factory).toBe('0x9bdcA5798E52e592A08e3b34d3F18EeF76Af7ef4')
    expect(jaine.swapRouter).toBe('0x8B598A7C136215A95ba0282b4d832B9f9801f2e2')
    expect(jaine.quoter).toBe('0xd00883722cECAD3A1c60bCA611f09e1851a0bE02')
    expect(jaine.weth9).toBe('0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c')
  })

  test('Gimo addresses match phase-10-design-locked.md', () => {
    const gimo = GIMO_BY_NETWORK['0g-mainnet']!
    expect(gimo.pool).toBe('0xac06d1df23a4fa00981afac0f33a5936bd2135af')
    expect(gimo.stog).toBe('0x7bbc63d01ca42491c3e084c941c3e86e55951404')
  })

  test('Multicall3 universal address', () => {
    expect(MULTICALL3).toBe('0xcA11bde05977b3631167028862bE2a173976CA11')
  })

  test('testnet has no JAINE/Gimo deployment', () => {
    expect(JAINE_BY_NETWORK['0g-testnet']).toBeNull()
    expect(GIMO_BY_NETWORK['0g-testnet']).toBeNull()
  })

  test('FEE_TIERS in increasing order', () => {
    expect(FEE_TIERS).toEqual([500, 3000, 10000])
  })

  test('MIN_STAKE_WEI = 0.01 0G', () => {
    expect(MIN_STAKE_WEI).toBe(10_000_000_000_000_000n)
  })

  test('requireMainnet throws on testnet', () => {
    expect(() => requireMainnet('0g-testnet' as never)).toThrow(/mainnet/)
  })

  test('requireMainnet allows mainnet', () => {
    expect(() => requireMainnet('0g-mainnet')).not.toThrow()
  })
})
