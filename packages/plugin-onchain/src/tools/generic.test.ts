import { describe, expect, test } from 'bun:test'
import { parseEther } from 'viem'
import { parseChainWriteValue } from './generic'

describe('parseChainWriteValue', () => {
  test('decimal 0G ("0.0001") returns wei via parseEther', () => {
    expect(parseChainWriteValue('0.0001')).toBe(parseEther('0.0001'))
  })

  test('integer wei string returns BigInt verbatim', () => {
    expect(parseChainWriteValue('100000000000000')).toBe(100_000_000_000_000n)
  })

  test('hex wei (no dot) routes through BigInt', () => {
    expect(parseChainWriteValue('0xde0b6b3a7640000')).toBe(parseEther('1'))
  })

  test('zero decimal returns 0n', () => {
    expect(parseChainWriteValue('0.0')).toBe(0n)
  })

  test('zero integer returns 0n', () => {
    expect(parseChainWriteValue('0')).toBe(0n)
  })

  test('leading whitespace trimmed', () => {
    expect(parseChainWriteValue('  0.5  ')).toBe(parseEther('0.5'))
  })

  test('full 1 0G decimal matches 1e18 wei', () => {
    expect(parseChainWriteValue('1.0')).toBe(parseEther('1'))
  })

  test('throws on garbage input via BigInt path', () => {
    expect(() => parseChainWriteValue('abc')).toThrow()
  })

  test('throws on garbage decimal via parseEther path', () => {
    expect(() => parseChainWriteValue('not.a.number')).toThrow()
  })
})
