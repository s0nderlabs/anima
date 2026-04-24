import { describe, expect, test } from 'bun:test'
import { decrypt, encrypt, packEnvelope, unpackEnvelope } from './encryption'

describe('encryption', () => {
  test('round-trips a short message', () => {
    const plaintext = new TextEncoder().encode('hello anima')
    const env = encrypt(plaintext, 'testpass1234')
    const out = decrypt(env, 'testpass1234')
    expect(new TextDecoder().decode(out)).toBe('hello anima')
  })

  test('wrong passphrase fails', () => {
    const env = encrypt(new TextEncoder().encode('secret'), 'right-password')
    expect(() => decrypt(env, 'wrong-password')).toThrow()
  })

  test('packs + unpacks round-trip', () => {
    const env = encrypt(new TextEncoder().encode('pack me'), 'pw')
    const packed = packEnvelope(env)
    const unpacked = unpackEnvelope(packed)
    expect(Array.from(unpacked.salt)).toEqual(Array.from(env.salt))
    expect(Array.from(unpacked.iv)).toEqual(Array.from(env.iv))
    expect(Array.from(unpacked.tag)).toEqual(Array.from(env.tag))
    expect(Array.from(unpacked.ciphertext)).toEqual(Array.from(env.ciphertext))
  })

  test('unpack throws on truncated input', () => {
    expect(() => unpackEnvelope(new Uint8Array(20))).toThrow('envelope shorter than header')
  })
})
