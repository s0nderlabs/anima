import { describe, expect, test } from 'bun:test'
import { generatePrivateKey } from 'viem/accounts'
import {
  MEMORY_BLOB_VERSION,
  decryptMemoryBytes,
  deriveMemoryKey,
  encryptMemoryBytes,
} from './encryption'

describe('memory encryption', () => {
  test('round-trip: encrypt + decrypt with same agent key', () => {
    const agentPriv = generatePrivateKey()
    const key = deriveMemoryKey(agentPriv)
    const plaintext = new TextEncoder().encode('# identity\n\nagent-001 minted at block 42\n')
    const blob = encryptMemoryBytes(plaintext, key)
    expect(blob[0]).toBe(MEMORY_BLOB_VERSION)
    const out = decryptMemoryBytes(blob, key)
    expect(new TextDecoder().decode(out)).toBe(new TextDecoder().decode(plaintext))
  })

  test('different agent keys produce different ciphertexts (key separation)', () => {
    const a = deriveMemoryKey(generatePrivateKey())
    const b = deriveMemoryKey(generatePrivateKey())
    const pt = new TextEncoder().encode('hello')
    const ba = encryptMemoryBytes(pt, a)
    const bb = encryptMemoryBytes(pt, b)
    expect(Buffer.from(ba).equals(Buffer.from(bb))).toBe(false)
    expect(() => decryptMemoryBytes(ba, b)).toThrow()
  })

  test('two encrypts of same plaintext yield different ciphertexts (random IV)', () => {
    const key = deriveMemoryKey(generatePrivateKey())
    const pt = new TextEncoder().encode('same plaintext')
    const a = encryptMemoryBytes(pt, key)
    const b = encryptMemoryBytes(pt, key)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
    expect(new TextDecoder().decode(decryptMemoryBytes(a, key))).toBe('same plaintext')
    expect(new TextDecoder().decode(decryptMemoryBytes(b, key))).toBe('same plaintext')
  })

  test('tampered ciphertext fails GCM auth', () => {
    const key = deriveMemoryKey(generatePrivateKey())
    const blob = encryptMemoryBytes(new TextEncoder().encode('x'), key)
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff
    expect(() => decryptMemoryBytes(blob, key)).toThrow()
  })

  test('rejects unsupported version byte', () => {
    const key = deriveMemoryKey(generatePrivateKey())
    const blob = encryptMemoryBytes(new TextEncoder().encode('x'), key)
    blob[0] = 99
    expect(() => decryptMemoryBytes(blob, key)).toThrow(/unsupported memory blob version/)
  })

  test('rejects too-short blob', () => {
    const key = deriveMemoryKey(generatePrivateKey())
    expect(() => decryptMemoryBytes(new Uint8Array([1, 2, 3]), key)).toThrow(/too short/)
  })

  test('determinism: same agent privkey always derives same key', () => {
    const priv = generatePrivateKey()
    const k1 = deriveMemoryKey(priv)
    const k2 = deriveMemoryKey(priv)
    expect(k1.equals(k2)).toBe(true)
  })
})
