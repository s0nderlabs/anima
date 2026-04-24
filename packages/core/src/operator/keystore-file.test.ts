import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet as EthersWallet } from 'ethers'
import { KeystoreFileOperatorSigner } from './keystore-file'

describe('KeystoreFileOperatorSigner', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'anima-keystore-file-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  test('decrypts a geth-format keystore and exposes the address', async () => {
    const privkey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
    const wallet = new EthersWallet(privkey)
    const encrypted = await wallet.encrypt('test-passphrase')
    const path = join(tmp, 'operator.json')
    await writeFile(path, encrypted)

    const signer = new KeystoreFileOperatorSigner({ path, passphrase: 'test-passphrase' })
    const address = await signer.address()
    expect(address.toLowerCase()).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8')
    expect(signer.source).toBe(`keystore:${path}`)
  }, 30_000)

  test('throws on wrong passphrase', async () => {
    const wallet = EthersWallet.createRandom()
    const encrypted = await wallet.encrypt('right')
    const path = join(tmp, 'operator.json')
    await writeFile(path, encrypted)

    const signer = new KeystoreFileOperatorSigner({ path, passphrase: 'wrong' })
    await expect(signer.address()).rejects.toThrow()
  }, 30_000)

  test('reports source label as keystore:<path>', () => {
    const signer = new KeystoreFileOperatorSigner({ path: '/tmp/fake.json', passphrase: 'x' })
    expect(signer.source).toBe('keystore:/tmp/fake.json')
  })
})
