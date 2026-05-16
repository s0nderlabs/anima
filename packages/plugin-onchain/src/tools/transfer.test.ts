import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { resolveRecipient } from './transfer'

// Minimal PublicClient shim — only readContract is invoked through
// resolveSubnameAddress → SANN resolver text record.
function fakeClient(textReturn: string): Partial<PublicClient> {
  return {
    readContract: async () => textReturn,
  } as Partial<PublicClient>
}

const SPECTER_EOA = '0x1e930c1647EaB93651FD94e760E0cbbb5F4FC99f'

describe('resolveRecipient', () => {
  test('checksummed 0x address passes through unchanged', async () => {
    const result = await resolveRecipient(SPECTER_EOA, fakeClient('') as PublicClient)
    expect(result).toBe(SPECTER_EOA)
  })

  test('lowercase 0x address is checksum-corrected', async () => {
    const lower = SPECTER_EOA.toLowerCase() as `0x${string}`
    const result = await resolveRecipient(lower, fakeClient('') as PublicClient)
    expect(result).toBe(SPECTER_EOA)
  })

  test('0x address with whitespace is trimmed', async () => {
    const result = await resolveRecipient(`  ${SPECTER_EOA}  `, fakeClient('') as PublicClient)
    expect(result).toBe(SPECTER_EOA)
  })

  test('.anima.0g subname resolves via SANN resolver', async () => {
    const result = await resolveRecipient('alice.anima.0g', fakeClient(SPECTER_EOA) as PublicClient)
    expect(result).toBe(SPECTER_EOA)
  })

  test('.anima.0g with empty text record throws', async () => {
    await expect(
      resolveRecipient('alice.anima.0g', fakeClient('') as PublicClient),
    ).rejects.toThrow(/empty or invalid/)
  })

  test('.anima.0g with garbage text record throws (caught by SANN getAddress)', async () => {
    await expect(
      resolveRecipient('alice.anima.0g', fakeClient('not-an-address') as PublicClient),
    ).rejects.toThrow(/empty or invalid/)
  })

  test('bare ".anima.0g" with no label throws', async () => {
    await expect(resolveRecipient('.anima.0g', fakeClient('') as PublicClient)).rejects.toThrow(
      /empty subname label/,
    )
  })

  test('non-address, non-suffix input throws with helpful message', async () => {
    await expect(resolveRecipient('alice', fakeClient('') as PublicClient)).rejects.toThrow(
      /expected 0x address or \*\.anima\.0g name/,
    )
  })

  test('alternate-tld name (alice.0g without .anima) is rejected', async () => {
    await expect(
      resolveRecipient('alice.0g', fakeClient(SPECTER_EOA) as PublicClient),
    ).rejects.toThrow(/expected 0x address/)
  })
})
