import { describe, expect, test } from 'bun:test'
import { RawPrivkeyOperatorSigner } from './raw-privkey'

const FIXTURE_PK = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const FIXTURE_ADDR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'

describe('RawPrivkeyOperatorSigner', () => {
  test('accepts hex with 0x prefix', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: `0x${FIXTURE_PK}` })
    expect((await signer.address()).toLowerCase()).toBe(FIXTURE_ADDR)
  })

  test('accepts hex without 0x prefix', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: FIXTURE_PK })
    expect((await signer.address()).toLowerCase()).toBe(FIXTURE_ADDR)
  })

  test('rejects non-hex input', () => {
    expect(() => new RawPrivkeyOperatorSigner({ privkey: 'not-a-key' })).toThrow()
  })

  test('rejects short hex', () => {
    expect(() => new RawPrivkeyOperatorSigner({ privkey: '0xabcd' })).toThrow()
  })

  test('rejects too-long hex', () => {
    expect(() => new RawPrivkeyOperatorSigner({ privkey: `0x${FIXTURE_PK}ff` })).toThrow()
  })

  test('source label defaults to raw-privkey', () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: `0x${FIXTURE_PK}` })
    expect(signer.source).toBe('raw-privkey')
  })

  test('source label respects explicit sourceLabel', () => {
    const signer = new RawPrivkeyOperatorSigner({
      privkey: `0x${FIXTURE_PK}`,
      sourceLabel: 'env:ANIMA_OPERATOR_PRIVKEY',
    })
    expect(signer.source).toBe('raw-privkey:env:ANIMA_OPERATOR_PRIVKEY')
  })
})
