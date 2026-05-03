import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet as EthersWallet } from 'ethers'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { KeystoreFileOperatorSigner } from '../operator/keystore-file'
import { RawPrivkeyOperatorSigner } from '../operator/raw-privkey'
import {
  OPERATOR_BLOB_SCOPES,
  OPERATOR_KEYSTORE_VERSION,
  decodeKeystoreBytes,
  decodeOperatorBlobBytes,
  decryptAgentKey,
  decryptOperatorBlob,
  encodeKeystoreBytes,
  encodeOperatorBlobBytes,
  encryptAgentKey,
  encryptOperatorBlob,
  sniffKeystoreVersion,
} from './operator-keystore-crypto'

describe('operator-keystore-crypto', () => {
  test('encrypt + decrypt round-trip via RawPrivkeyOperatorSigner', async () => {
    const operatorPrivkey = generatePrivateKey()
    const signer = new RawPrivkeyOperatorSigner({ privkey: operatorPrivkey })
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address

    const keystore = await encryptAgentKey({ signer, agentAddress, agentPrivkey })
    expect(keystore.version).toBe(OPERATOR_KEYSTORE_VERSION)
    expect(keystore.blob.length).toBeGreaterThan(0)

    const decrypted = await decryptAgentKey({ signer, agentAddress, keystore })
    expect(decrypted).toBe(agentPrivkey)
  })

  test('encrypt + decrypt round-trip via KeystoreFileOperatorSigner', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'anima-op-ks-'))
    try {
      const operatorPrivkey = generatePrivateKey()
      const ethersWallet = new EthersWallet(operatorPrivkey)
      const encryptedJson = await ethersWallet.encrypt('test-passphrase')
      const path = join(tmp, 'operator.json')
      await writeFile(path, encryptedJson)

      const signer = new KeystoreFileOperatorSigner({ path, passphrase: 'test-passphrase' })
      const agentPrivkey = generatePrivateKey()
      const agentAddress = privateKeyToAccount(agentPrivkey).address

      const keystore = await encryptAgentKey({ signer, agentAddress, agentPrivkey })
      const decrypted = await decryptAgentKey({ signer, agentAddress, keystore })
      expect(decrypted).toBe(agentPrivkey)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 30_000)

  test('different operator privkeys derive different keys (cross-decrypt fails)', async () => {
    const operatorA = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const operatorB = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address

    const keystore = await encryptAgentKey({ signer: operatorA, agentAddress, agentPrivkey })
    await expect(decryptAgentKey({ signer: operatorB, agentAddress, keystore })).rejects.toThrow()
  })

  test('different agent addresses derive different keys (so blobs are domain-separated)', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agentA = privateKeyToAccount(generatePrivateKey()).address
    const agentB = privateKeyToAccount(generatePrivateKey()).address
    const agentPrivkey = generatePrivateKey()

    const keystore = await encryptAgentKey({ signer, agentAddress: agentA, agentPrivkey })
    await expect(decryptAgentKey({ signer, agentAddress: agentB, keystore })).rejects.toThrow()
  })

  test('two keystores from same operator+agent produce different ciphertexts (random IV)', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address

    const ks1 = await encryptAgentKey({ signer, agentAddress, agentPrivkey })
    const ks2 = await encryptAgentKey({ signer, agentAddress, agentPrivkey })
    expect(ks1.blob).not.toBe(ks2.blob)
    expect(await decryptAgentKey({ signer, agentAddress, keystore: ks1 })).toBe(agentPrivkey)
    expect(await decryptAgentKey({ signer, agentAddress, keystore: ks2 })).toBe(agentPrivkey)
  })

  test('encodeKeystoreBytes + decodeKeystoreBytes round-trip', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address

    const keystore = await encryptAgentKey({ signer, agentAddress, agentPrivkey })
    const bytes = encodeKeystoreBytes(keystore)
    const decoded = decodeKeystoreBytes(bytes)
    expect(decoded.version).toBe(keystore.version)
    expect(decoded.blob).toBe(keystore.blob)
    expect(await decryptAgentKey({ signer, agentAddress, keystore: decoded })).toBe(agentPrivkey)
  })

  test('decode rejects v1 (passphrase) blobs cleanly', () => {
    const v1Blob = new TextEncoder().encode(JSON.stringify({ version: 1, blob: 'x' }))
    expect(() => decodeKeystoreBytes(v1Blob)).toThrow(/version 1/)
  })

  test('sniffKeystoreVersion returns version field for both v1 and v2 shapes', () => {
    const v1Bytes = new TextEncoder().encode(JSON.stringify({ version: 1, blob: 'aaaa' }))
    const v2Bytes = new TextEncoder().encode(JSON.stringify({ version: 2, blob: 'bbbb' }))
    const garbage = new TextEncoder().encode('not-json')
    expect(sniffKeystoreVersion(v1Bytes)).toBe(1)
    expect(sniffKeystoreVersion(v2Bytes)).toBe(2)
    expect(sniffKeystoreVersion(garbage)).toBeNull()
  })

  test('signer determinism: same operator + agent produces same derived key (decrypt across calls works)', async () => {
    const operatorPrivkey = generatePrivateKey()
    const signerA = new RawPrivkeyOperatorSigner({ privkey: operatorPrivkey })
    const signerB = new RawPrivkeyOperatorSigner({ privkey: operatorPrivkey })
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address

    const keystore = await encryptAgentKey({ signer: signerA, agentAddress, agentPrivkey })
    const decrypted = await decryptAgentKey({ signer: signerB, agentAddress, keystore })
    expect(decrypted).toBe(agentPrivkey)
  })

  // -- encryptOperatorBlob / decryptOperatorBlob (Phase 12 generalized helpers)

  test('operator blob: encrypt + decrypt round-trip with telegram scope', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ telegram: { botToken: 'abc:xyz', allowedUserIds: [123] } }),
    )
    const blob = await encryptOperatorBlob({
      signer,
      scope: OPERATOR_BLOB_SCOPES.TELEGRAM,
      agentAddress: agent,
      plaintext,
    })
    expect(blob.version).toBe(OPERATOR_KEYSTORE_VERSION)
    expect(blob.scope).toBe(OPERATOR_BLOB_SCOPES.TELEGRAM)
    const decrypted = await decryptOperatorBlob({
      signer,
      scope: OPERATOR_BLOB_SCOPES.TELEGRAM,
      agentAddress: agent,
      blob,
    })
    expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(plaintext))
  })

  test('operator blob: scope mismatch refuses decrypt', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const blob = await encryptOperatorBlob({
      signer,
      scope: OPERATOR_BLOB_SCOPES.TELEGRAM,
      agentAddress: agent,
      plaintext: new TextEncoder().encode('payload'),
    })
    await expect(
      decryptOperatorBlob({
        signer,
        scope: OPERATOR_BLOB_SCOPES.KEYSTORE, // intentionally wrong
        agentAddress: agent,
        blob,
      }),
    ).rejects.toThrow(/scope mismatch/)
  })

  test('operator blob: cross-scope keys are different (sig replay across scopes is impossible)', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const tgBlob = await encryptOperatorBlob({
      signer,
      scope: OPERATOR_BLOB_SCOPES.TELEGRAM,
      agentAddress: agent,
      plaintext: new TextEncoder().encode('tg-payload'),
    })
    // Force a "fake" keystore-scoped blob by hand-mutating tgBlob.scope and
    // re-trying decrypt under KEYSTORE scope. Should fail with auth/scope
    // error, never silently leak.
    const tampered = { ...tgBlob, scope: OPERATOR_BLOB_SCOPES.KEYSTORE }
    await expect(
      decryptOperatorBlob({
        signer,
        scope: OPERATOR_BLOB_SCOPES.KEYSTORE,
        agentAddress: agent,
        blob: tampered,
      }),
    ).rejects.toThrow()
  })

  test('operator blob: encode/decode bytes round-trip', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const blob = await encryptOperatorBlob({
      signer,
      scope: OPERATOR_BLOB_SCOPES.TELEGRAM,
      agentAddress: agent,
      plaintext: new TextEncoder().encode('hello'),
    })
    const bytes = encodeOperatorBlobBytes(blob)
    const decoded = decodeOperatorBlobBytes(bytes)
    expect(decoded.version).toBe(blob.version)
    expect(decoded.scope).toBe(blob.scope)
    expect(decoded.blob).toBe(blob.blob)
  })
})
