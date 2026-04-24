import { describe, expect, test } from 'bun:test'
import { SANN_ADDRESSES, sannNamehash, subnameNode } from './sann'

describe('sann namehash', () => {
  test('baseNode for 0g matches on-chain readout', () => {
    const base = sannNamehash(SANN_ADDRESSES.tldIdentifier, '0g', [])
    expect(base).toBe('0x3e6ae2a6b7e1fb0e2af0c69c8d7d4e285626695305c4cf0e1399e5f24b53c38c')
  })

  test('anima.0g matches on-chain readout', () => {
    const node = sannNamehash(SANN_ADDRESSES.tldIdentifier, '0g', ['anima'])
    expect(node).toBe('0xb8a6c74b0b09d90544912d761c6c285b8d1e4336f3cdd13cfa35469b943ff182')
  })

  test('subnameNode for alice.anima.0g is deterministic', () => {
    const a = subnameNode('alice')
    const b = subnameNode('alice')
    expect(a).toBe(b)
  })

  test('different labels produce different subname nodes', () => {
    expect(subnameNode('alice')).not.toBe(subnameNode('bob'))
  })
})
