import { describe, expect, it } from 'bun:test'
import { derivePubkeyHex } from '@s0nderlabs/anima-core'
import { _internal, eciesDecryptFromHex, eciesEncryptToHex } from './crypto'

const ALICE_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const BOB_PRIV = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d'

describe('crypto: pubkey normalization', () => {
  it('strips 0x04 prefix from a 65-byte uncompressed pubkey', () => {
    const pubkey = derivePubkeyHex(ALICE_PRIV)
    const norm = _internal.normalizePubkeyForEthCrypto(pubkey)
    expect(norm.length).toBe(128)
    expect(norm.startsWith('04')).toBe(false)
  })

  it('strips a leading 04 if 0x is omitted', () => {
    const pubkey = derivePubkeyHex(ALICE_PRIV).slice(2) // drop 0x
    const norm = _internal.normalizePubkeyForEthCrypto(pubkey)
    expect(norm.length).toBe(128)
  })

  it('throws on a wrong-length pubkey', () => {
    expect(() => _internal.normalizePubkeyForEthCrypto('0xdeadbeef')).toThrow()
  })
})

describe('crypto: ECIES roundtrip', () => {
  it('encrypts plaintext bytes to a hex envelope and decrypts back', async () => {
    const plaintext = new TextEncoder().encode('hello bob')
    const bobPub = derivePubkeyHex(BOB_PRIV)
    const env = await eciesEncryptToHex(plaintext, bobPub)
    expect(env.startsWith('0x')).toBe(true)
    expect(env.length).toBeGreaterThan(200) // hex envelope is meaty
    const decrypted = await eciesDecryptFromHex(env, BOB_PRIV)
    expect(new TextDecoder().decode(decrypted)).toBe('hello bob')
  })

  it('alice encrypting cannot decrypt with her own key', async () => {
    const plaintext = new TextEncoder().encode('only-bob')
    const bobPub = derivePubkeyHex(BOB_PRIV)
    const env = await eciesEncryptToHex(plaintext, bobPub)
    await expect(eciesDecryptFromHex(env, ALICE_PRIV)).rejects.toThrow()
  })

  it('handles binary payloads (not just utf-8)', async () => {
    const random = new Uint8Array(256)
    for (let i = 0; i < 256; i++) random[i] = i
    const bobPub = derivePubkeyHex(BOB_PRIV)
    const env = await eciesEncryptToHex(random, bobPub)
    const back = await eciesDecryptFromHex(env, BOB_PRIV)
    expect(back).toEqual(random)
  })

  it('large plaintext roundtrips', async () => {
    const big = new TextEncoder().encode('x'.repeat(2048))
    const bobPub = derivePubkeyHex(BOB_PRIV)
    const env = await eciesEncryptToHex(big, bobPub)
    const back = await eciesDecryptFromHex(env, BOB_PRIV)
    expect(back).toEqual(big)
  })

  it('accepts pubkeys with or without 0x prefix', async () => {
    const plaintext = new TextEncoder().encode('hi')
    const bobPub = derivePubkeyHex(BOB_PRIV)
    const env1 = await eciesEncryptToHex(plaintext, bobPub)
    const env2 = await eciesEncryptToHex(plaintext, bobPub.slice(2))
    expect(new TextDecoder().decode(await eciesDecryptFromHex(env1, BOB_PRIV))).toBe('hi')
    expect(new TextDecoder().decode(await eciesDecryptFromHex(env2, BOB_PRIV))).toBe('hi')
  })
})
