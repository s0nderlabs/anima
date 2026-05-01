import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isNativeToken,
  loadTokenCache,
  lookupFromList,
  nativeTokenInfo,
  rememberToken,
  saveTokenCache,
} from './tokens'
import type { TokenInfo } from './types'

describe('isNativeToken', () => {
  test('matches all 0G aliases', () => {
    for (const alias of ['0G', 'OG', 'native', '0g', 'og']) {
      expect(isNativeToken(alias)).toBe(true)
    }
  })

  test('rejects ERC-20 symbols', () => {
    expect(isNativeToken('USDCe')).toBe(false)
    expect(isNativeToken('stOG')).toBe(false)
    expect(isNativeToken('0x1234')).toBe(false)
  })

  test('treats undefined as native (default behavior)', () => {
    expect(isNativeToken(undefined)).toBe(true)
  })
})

describe('nativeTokenInfo', () => {
  test('returns 18-decimal 0G stub', () => {
    const t = nativeTokenInfo()
    expect(t.symbol).toBe('0G')
    expect(t.decimals).toBe(18)
    expect(t.source).toBe('native')
  })
})

describe('lookupFromList', () => {
  test('finds USDCe by symbol', () => {
    const cache = { version: 1 as const, byAddress: {} }
    const t = lookupFromList('USDCe', cache)
    expect(t?.symbol).toBe('USDCe')
    expect(t?.decimals).toBe(6)
    expect(t?.address.toLowerCase()).toBe('0x1f3aa82227281ca364bfb3d253b0f1af1da6473e')
    expect(t?.source).toBe('list')
  })

  test('finds st0G case-insensitively (vendored list uses zero-not-O)', () => {
    const cache = { version: 1 as const, byAddress: {} }
    const t = lookupFromList('st0g', cache)
    expect(t?.symbol).toBe('st0G')
    expect(t?.decimals).toBe(18)
  })

  test('finds by address', () => {
    const cache = { version: 1 as const, byAddress: {} }
    const t = lookupFromList('0x1f3aa82227281ca364bfb3d253b0f1af1da6473e', cache)
    expect(t?.symbol).toBe('USDCe')
  })

  test('cache wins over vendored list', () => {
    const cache = {
      version: 1 as const,
      byAddress: {
        '0xabcdef1234567890abcdef1234567890abcdef12': {
          address: '0xabcdef1234567890abcdef1234567890abcdef12' as `0x${string}`,
          symbol: 'CUSTOM',
          name: 'Custom Token',
          decimals: 9,
          source: 'cache' as const,
        },
      },
    }
    const t = lookupFromList('0xabcdef1234567890abcdef1234567890abcdef12', cache)
    expect(t?.symbol).toBe('CUSTOM')
    expect(t?.source).toBe('cache')
  })

  test('returns null on unknown', () => {
    const cache = { version: 1 as const, byAddress: {} }
    expect(lookupFromList('NEVERHEARD', cache)).toBeNull()
  })
})

describe('cache I/O round-trip', () => {
  test('save+load preserves token info', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anima-onchain-test-'))
    const initial = loadTokenCache(dir)
    expect(initial.byAddress).toEqual({})
    const tok: TokenInfo = {
      address: '0x1234567890123456789012345678901234567890' as `0x${string}`,
      symbol: 'TEST',
      name: 'Test',
      decimals: 18,
      source: 'onchain',
    }
    rememberToken(dir, tok)
    const reloaded = loadTokenCache(dir)
    expect(reloaded.byAddress[tok.address.toLowerCase()]?.symbol).toBe('TEST')
  })

  test('saveTokenCache replaces existing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anima-onchain-test-'))
    saveTokenCache(dir, {
      version: 1,
      byAddress: {
        '0xaaa': {
          address: '0xaaa' as `0x${string}`,
          symbol: 'A',
          decimals: 18,
          source: 'cache',
        },
      },
    })
    saveTokenCache(dir, {
      version: 1,
      byAddress: {
        '0xbbb': {
          address: '0xbbb' as `0x${string}`,
          symbol: 'B',
          decimals: 6,
          source: 'cache',
        },
      },
    })
    const reloaded = loadTokenCache(dir)
    expect(Object.keys(reloaded.byAddress)).toEqual(['0xbbb'])
  })
})
