import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet as EthersWallet } from 'ethers'
import type { Address, Chain, LocalAccount, PublicClient, WalletClient } from 'viem'
import {
  type PrivateKeyAccount,
  generatePrivateKey,
  privateKeyToAccount,
  toAccount,
} from 'viem/accounts'
import { KeystoreFileOperatorSigner } from '../operator/keystore-file'
import { RawPrivkeyOperatorSigner } from '../operator/raw-privkey'
import type { OperatorSigner } from '../operator/signer'
import {
  OPERATOR_BLOB_SCOPES,
  OPERATOR_KEYSTORE_VERSION,
  decodeKeystoreBytes,
  decodeOperatorBlobBytes,
  decryptAgentKey,
  decryptOperatorBlob,
  deriveBlobKey,
  deriveKeystoreKey,
  deriveLegacyEmptyDomainKey,
  encodeKeystoreBytes,
  encodeOperatorBlobBytes,
  encryptAgentKey,
  encryptOperatorBlob,
  sniffKeystoreVersion,
  tryDecryptKeystoreWithKey,
  tryDecryptOperatorBlobWithKey,
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

  // -- v0.24.9 WC EIP712Domain canonical + legacy fallback

  /**
   * MockDualVariantSigner simulates the post-v0.24.9 WC Account that signs
   * canonically by default but exposes `signTypedDataLegacyEmptyDomain` for
   * backwards-compat decrypt of pre-v0.24.9 keystores. The mock backs the
   * two paths with two DIFFERENT operator privkeys so the resulting ECDSA
   * signatures (and the HKDF-derived AES keys) genuinely differ. This is
   * exactly the divergence the real WC + MM behavior caused: same operator
   * EOA, two different domain-separator hashes, two different sigs.
   */
  class MockDualVariantSigner implements OperatorSigner {
    readonly source = 'mock-dual-variant'
    constructor(
      private readonly canonicalAcct: PrivateKeyAccount,
      private readonly legacyAcct: PrivateKeyAccount,
    ) {}
    async address(): Promise<Address> {
      return this.canonicalAcct.address
    }
    async account(): Promise<LocalAccount> {
      const canonical = this.canonicalAcct
      const legacy = this.legacyAcct
      const acct = toAccount({
        address: canonical.address,
        async signMessage({ message }) {
          return canonical.signMessage({ message })
        },
        async signTransaction(tx) {
          return canonical.signTransaction(tx)
        },
        // biome-ignore lint/suspicious/noExplicitAny: forwarding typed-data
        async signTypedData(td: any) {
          return canonical.signTypedData(td)
        },
      })
      Object.defineProperty(acct, 'signTypedDataLegacyEmptyDomain', {
        // biome-ignore lint/suspicious/noExplicitAny: escape hatch is intentionally untyped
        value: async (td: any) => legacy.signTypedData(td),
        enumerable: false,
        writable: false,
      })
      return acct
    }
    async walletClient(): Promise<WalletClient> {
      throw new Error('walletClient unused in test')
    }
    async publicClient(): Promise<PublicClient> {
      throw new Error('publicClient unused in test')
    }
    chain(): Chain {
      throw new Error('chain unused in test')
    }
  }

  test('legacy fallback: keystore encrypted under empty-domain variant decrypts via fallback', async () => {
    // Simulate pre-v0.24.9: legacy WC's "canonical" was the empty-EIP712Domain
    // hash, so the on-disk keystore is bound to privkey L's signature. After
    // the v0.24.9 fix, the same operator's signTypedData now produces the
    // canonical hash (different sig → different AES key). The mock signer
    // returns canonical-acct's sig on signTypedData (which fails AES-GCM)
    // and legacy-acct's sig on signTypedDataLegacyEmptyDomain (which is what
    // the keystore was encrypted under, so the fallback succeeds).
    const canonicalPrivkey = generatePrivateKey()
    const legacyPrivkey = generatePrivateKey()
    const canonicalAcct = privateKeyToAccount(canonicalPrivkey)
    const legacyAcct = privateKeyToAccount(legacyPrivkey)
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address

    // Encrypt the keystore with the LEGACY privkey acting as the operator
    // (mirrors what a pre-v0.24.9 WC init wrote to disk).
    const legacyOnlySigner = new RawPrivkeyOperatorSigner({ privkey: legacyPrivkey })
    const keystore = await encryptAgentKey({
      signer: legacyOnlySigner,
      agentAddress,
      agentPrivkey,
    })

    // Decrypt with the dual-variant mock: canonical sig fails AES-GCM, but
    // the legacy fallback method returns legacy-acct's sig and succeeds.
    const dualSigner = new MockDualVariantSigner(canonicalAcct, legacyAcct)
    const decrypted = await decryptAgentKey({
      signer: dualSigner,
      agentAddress,
      keystore,
    })
    expect(decrypted).toBe(agentPrivkey)
  })

  test('legacy fallback: post-v0.24.9 keystore (canonical) decrypts first try without invoking fallback', async () => {
    // After v0.24.9: same canonical privkey encrypts + decrypts. Legacy method
    // exists on the signer but is never invoked because canonical AES-GCM
    // succeeds on the first attempt. We assert this by routing the legacy
    // method through a privkey that would produce a totally different sig if
    // ever called — decrypt must still succeed cleanly.
    const canonicalAcct = privateKeyToAccount(generatePrivateKey())
    const legacyAcct = privateKeyToAccount(generatePrivateKey())
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address

    const dualSigner = new MockDualVariantSigner(canonicalAcct, legacyAcct)
    const keystore = await encryptAgentKey({
      signer: dualSigner,
      agentAddress,
      agentPrivkey,
    })
    const decrypted = await decryptAgentKey({
      signer: dualSigner,
      agentAddress,
      keystore,
    })
    expect(decrypted).toBe(agentPrivkey)
  })

  test('legacy fallback: LocalAccount signers without the escape hatch keep canonical-only behavior', async () => {
    // RawPrivkeyOperatorSigner (LocalAccount) never exposes
    // signTypedDataLegacyEmptyDomain. A keystore encrypted under operator A's
    // canonical sig cannot be decrypted by operator B; the fallback is a
    // no-op and the original AES-GCM failure surfaces unchanged.
    const operatorA = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const operatorB = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address

    const keystore = await encryptAgentKey({ signer: operatorA, agentAddress, agentPrivkey })
    await expect(decryptAgentKey({ signer: operatorB, agentAddress, keystore })).rejects.toThrow(
      /Unsupported state or unable to authenticate/,
    )
  })

  test('legacy fallback: precomputedKey path skips fallback (cached key is trusted)', async () => {
    // The headless gateway path caches the canonical AES key in
    // .operator-session and passes it as precomputedKey. If the cache is
    // stale or wrong, fail loud, never try to silently re-sign via the
    // legacy fallback.
    const canonicalPrivkey = generatePrivateKey()
    const legacyPrivkey = generatePrivateKey()
    const canonicalAcct = privateKeyToAccount(canonicalPrivkey)
    const legacyAcct = privateKeyToAccount(legacyPrivkey)
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address

    const legacyOnlySigner = new RawPrivkeyOperatorSigner({ privkey: legacyPrivkey })
    const keystore = await encryptAgentKey({
      signer: legacyOnlySigner,
      agentAddress,
      agentPrivkey,
    })

    // Pass a wrong 32-byte precomputedKey. Even with a dual-variant signer
    // available, the fallback must NOT be attempted because the caller
    // explicitly opted into cached-key mode.
    const wrongKey = Buffer.alloc(32, 0)
    const dualSigner = new MockDualVariantSigner(canonicalAcct, legacyAcct)
    await expect(
      decryptAgentKey({
        signer: dualSigner,
        agentAddress,
        keystore,
        precomputedKey: wrongKey,
      }),
    ).rejects.toThrow(/Unsupported state or unable to authenticate/)
  })

  test('legacy fallback: operator-blob decrypt also threads the dual-path on scoped blobs', async () => {
    // The same EIP712Domain trap affected Phase 12 telegram blobs + the v0.23
    // PROFILE slot. Verify decryptOperatorBlob applies the same fallback.
    const canonicalPrivkey = generatePrivateKey()
    const legacyPrivkey = generatePrivateKey()
    const canonicalAcct = privateKeyToAccount(canonicalPrivkey)
    const legacyAcct = privateKeyToAccount(legacyPrivkey)
    const agentAddress = privateKeyToAccount(generatePrivateKey()).address

    const legacyOnlySigner = new RawPrivkeyOperatorSigner({ privkey: legacyPrivkey })
    const blob = await encryptOperatorBlob({
      signer: legacyOnlySigner,
      scope: OPERATOR_BLOB_SCOPES.PROFILE,
      agentAddress,
      plaintext: new TextEncoder().encode('legacy-profile-payload'),
    })
    const dualSigner = new MockDualVariantSigner(canonicalAcct, legacyAcct)
    const pt = await decryptOperatorBlob({
      signer: dualSigner,
      scope: OPERATOR_BLOB_SCOPES.PROFILE,
      agentAddress,
      blob,
    })
    expect(new TextDecoder().decode(pt)).toBe('legacy-profile-payload')
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

  // -- v0.24.10 verify helpers + legacy derive wrapper --------------------

  test('tryDecryptKeystoreWithKey: true with matching key, false with wrong key', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address
    const keystore = await encryptAgentKey({ signer, agentAddress, agentPrivkey })
    const rightKey = await deriveKeystoreKey(signer, agentAddress)
    const wrongKey = Buffer.alloc(32, 0xab)
    expect(tryDecryptKeystoreWithKey(keystore, rightKey)).toBe(true)
    expect(tryDecryptKeystoreWithKey(keystore, wrongKey)).toBe(false)
  })

  test('tryDecryptKeystoreWithKey: rejects key with wrong length without throwing', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agentPrivkey = generatePrivateKey()
    const agentAddress = privateKeyToAccount(agentPrivkey).address
    const keystore = await encryptAgentKey({ signer, agentAddress, agentPrivkey })
    expect(tryDecryptKeystoreWithKey(keystore, Buffer.alloc(16, 0))).toBe(false)
    expect(tryDecryptKeystoreWithKey(keystore, Buffer.alloc(64, 0))).toBe(false)
  })

  test('tryDecryptOperatorBlobWithKey: scope mismatch returns false even with correct key', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const blob = await encryptOperatorBlob({
      signer,
      scope: OPERATOR_BLOB_SCOPES.PROFILE,
      agentAddress: agent,
      plaintext: new TextEncoder().encode('hi'),
    })
    const profileKey = await deriveBlobKey(signer, agent, OPERATOR_BLOB_SCOPES.PROFILE)
    expect(tryDecryptOperatorBlobWithKey(blob, profileKey, OPERATOR_BLOB_SCOPES.PROFILE)).toBe(true)
    // Wrong scope label refuses even though the AES key is otherwise correct.
    expect(tryDecryptOperatorBlobWithKey(blob, profileKey, OPERATOR_BLOB_SCOPES.TELEGRAM)).toBe(
      false,
    )
  })

  test('deriveLegacyEmptyDomainKey: returns null when signer has no legacy escape', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agent = privateKeyToAccount(generatePrivateKey()).address
    expect(await deriveLegacyEmptyDomainKey(signer, agent, 'keystore')).toBeNull()
    expect(await deriveLegacyEmptyDomainKey(signer, agent, OPERATOR_BLOB_SCOPES.PROFILE)).toBeNull()
  })

  test('deriveLegacyEmptyDomainKey: returns the legacy-variant key for dual signer (matches direct derive)', async () => {
    const canonicalAcct = privateKeyToAccount(generatePrivateKey())
    const legacyPrivkey = generatePrivateKey()
    const legacyAcct = privateKeyToAccount(legacyPrivkey)
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const dualSigner = new MockDualVariantSigner(canonicalAcct, legacyAcct)

    // The legacy-variant key derived via the escape hatch should equal the
    // key derived directly from the legacy privkey acting as a normal signer
    // (same EIP-712 message, same HKDF info, same RFC-6979 deterministic sig).
    const legacyDirectSigner = new RawPrivkeyOperatorSigner({ privkey: legacyPrivkey })
    const legacyViaEscape = await deriveLegacyEmptyDomainKey(dualSigner, agent, 'keystore')
    const legacyDirect = await deriveKeystoreKey(legacyDirectSigner, agent)
    expect(legacyViaEscape).not.toBeNull()
    expect(legacyViaEscape!.equals(legacyDirect)).toBe(true)

    // Same for PROFILE scope.
    const legacyProfileViaEscape = await deriveLegacyEmptyDomainKey(
      dualSigner,
      agent,
      OPERATOR_BLOB_SCOPES.PROFILE,
    )
    const legacyProfileDirect = await deriveBlobKey(
      legacyDirectSigner,
      agent,
      OPERATOR_BLOB_SCOPES.PROFILE,
    )
    expect(legacyProfileViaEscape).not.toBeNull()
    expect(legacyProfileViaEscape!.equals(legacyProfileDirect)).toBe(true)
  })
})
