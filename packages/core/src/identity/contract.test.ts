import { describe, expect, test } from 'bun:test'
import { keccak256, toBytes } from 'viem'
import { bootstrapHashFor, buildMintEntries } from './contract'
import { INTELLIGENT_DATA_SLOTS } from './intelligent-data'

describe('identity/contract helpers', () => {
  test('bootstrapHashFor matches keccak256("anima:bootstrap:<slot>")', () => {
    for (const slot of INTELLIGENT_DATA_SLOTS) {
      const expected = keccak256(toBytes(`anima:bootstrap:${slot}`))
      expect(bootstrapHashFor(slot)).toBe(expected)
    }
  })

  test('buildMintEntries returns 6 entries in canonical order', () => {
    const entries = buildMintEntries({})
    expect(entries.length).toBe(6)
    for (let i = 0; i < INTELLIGENT_DATA_SLOTS.length; i++) {
      const slot = INTELLIGENT_DATA_SLOTS[i]
      const entry = entries[i]
      if (!slot || !entry) throw new Error('unreachable')
      expect(entry.dataDescription).toBe(slot)
      expect(entry.dataHash).toBe(bootstrapHashFor(slot))
    }
  })

  test('buildMintEntries overrides with real hashes when provided', () => {
    const real = keccak256(toBytes('real-keystore-hash'))
    const entries = buildMintEntries({ keystore: real })
    const keystoreEntry = entries.find(e => e.dataDescription === 'keystore')
    expect(keystoreEntry?.dataHash).toBe(real)
    const identityEntry = entries.find(e => e.dataDescription === 'identity')
    expect(identityEntry?.dataHash).toBe(bootstrapHashFor('identity'))
  })
})
