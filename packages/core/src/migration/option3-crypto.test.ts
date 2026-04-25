import { describe, expect, test } from 'bun:test'
import { generatePrivateKey } from 'viem/accounts'
import { decryptWithPrivkey, encryptToPubkey, generateBootstrapKeypair } from './option3-crypto'

describe('option3-crypto', () => {
  test('round-trip: encrypt to pubkey, decrypt with privkey', () => {
    const recipient = generateBootstrapKeypair()
    const plaintext = new TextEncoder().encode('hello option 3')

    const env = encryptToPubkey({
      recipientPubkey: recipient.pubkeyHexCompressed,
      plaintext,
    })
    const decrypted = decryptWithPrivkey({
      recipientPrivkey: recipient.privkeyHex,
      envelope: env,
    })
    expect(new TextDecoder().decode(decrypted)).toBe('hello option 3')
  })

  test('round-trip with uncompressed pubkey', () => {
    const recipient = generateBootstrapKeypair()
    const plaintext = new TextEncoder().encode('uncompressed test')

    const env = encryptToPubkey({
      recipientPubkey: recipient.pubkeyHexUncompressed,
      plaintext,
    })
    const decrypted = decryptWithPrivkey({
      recipientPrivkey: recipient.privkeyHex,
      envelope: env,
    })
    expect(new TextDecoder().decode(decrypted)).toBe('uncompressed test')
  })

  test('encrypts a 32-byte agent privkey end-to-end', () => {
    const container = generateBootstrapKeypair()
    const agentPrivkey = generatePrivateKey()
    const plaintext = new Uint8Array(Buffer.from(agentPrivkey.slice(2), 'hex'))

    const env = encryptToPubkey({
      recipientPubkey: container.pubkeyHexCompressed,
      plaintext,
    })
    const decrypted = decryptWithPrivkey({
      recipientPrivkey: container.privkeyHex,
      envelope: env,
    })
    expect(`0x${Buffer.from(decrypted).toString('hex')}`).toBe(agentPrivkey)
  })

  test('different ephemeral keys per encryption (no nonce reuse)', () => {
    const recipient = generateBootstrapKeypair()
    const plaintext = new TextEncoder().encode('same plaintext')

    const e1 = encryptToPubkey({ recipientPubkey: recipient.pubkeyHexCompressed, plaintext })
    const e2 = encryptToPubkey({ recipientPubkey: recipient.pubkeyHexCompressed, plaintext })
    expect(e1.ephPubkeyHex).not.toBe(e2.ephPubkeyHex)
    expect(e1.ivHex).not.toBe(e2.ivHex)
    expect(e1.ciphertextHex).not.toBe(e2.ciphertextHex)
  })

  test('decrypt fails with wrong privkey', () => {
    const recipient = generateBootstrapKeypair()
    const attacker = generateBootstrapKeypair()
    const plaintext = new TextEncoder().encode('private')

    const env = encryptToPubkey({
      recipientPubkey: recipient.pubkeyHexCompressed,
      plaintext,
    })
    expect(() =>
      decryptWithPrivkey({ recipientPrivkey: attacker.privkeyHex, envelope: env }),
    ).toThrow()
  })

  test('decrypt fails when ciphertext tampered', () => {
    const recipient = generateBootstrapKeypair()
    const plaintext = new TextEncoder().encode('integrity matters')

    const env = encryptToPubkey({
      recipientPubkey: recipient.pubkeyHexCompressed,
      plaintext,
    })
    const tampered = {
      ...env,
      ciphertextHex: (env.ciphertextHex.slice(0, -2) +
        (env.ciphertextHex.endsWith('00') ? 'ff' : '00')) as `0x${string}`,
    }
    expect(() =>
      decryptWithPrivkey({ recipientPrivkey: recipient.privkeyHex, envelope: tampered }),
    ).toThrow()
  })

  test('rejects malformed pubkey length', () => {
    expect(() =>
      encryptToPubkey({
        recipientPubkey: '0xdeadbeef' as `0x${string}`,
        plaintext: new Uint8Array([1, 2, 3]),
      }),
    ).toThrow(/Invalid recipient pubkey length/)
  })
})
