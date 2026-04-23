import { expect, test } from 'bun:test'
import { Wallet } from 'ethers'
import { decryptKey, encryptKey } from './keystore'

test('encrypt + decrypt round-trip', () => {
  const w = Wallet.createRandom()
  const pk = new Uint8Array(Buffer.from(w.privateKey.replace(/^0x/, ''), 'hex'))
  const encrypted = encryptKey(pk, 'test-passphrase')
  expect(encrypted.version).toBe(1)
  const decrypted = decryptKey(encrypted, 'test-passphrase')
  expect(Buffer.from(decrypted).toString('hex')).toBe(Buffer.from(pk).toString('hex'))
})

test('wrong passphrase fails', () => {
  const pk = new Uint8Array(32).fill(0xab)
  const encrypted = encryptKey(pk, 'right')
  expect(() => decryptKey(encrypted, 'wrong')).toThrow()
})
