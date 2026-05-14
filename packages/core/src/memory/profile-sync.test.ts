import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import {
  OPERATOR_BLOB_SCOPES,
  decodeOperatorBlobBytes,
  decryptOperatorBlob,
  encodeOperatorBlobBytes,
  encryptOperatorBlob,
} from '../wallet/operator-keystore-crypto'
import { restoreProfile, syncProfile } from './profile-sync'

/**
 * v0.23.0 profile-sync round trip: the operator-scoped PROFILE key encrypts
 * via `encryptOperatorBlob` and restores via `restoreProfile`. End-to-end
 * with no chain calls — `syncProfile` is exercised separately because it
 * pushes to 0G Storage. Here we slice the path at the blob layer.
 */
describe('profile-sync round trip (precomputedKey path)', () => {
  test('encrypt → decrypt → write produces original plaintext', async () => {
    const profileKey = Buffer.from(randomBytes(32))
    const original = '# Profile\n\nname: elpabl0\nrole: hackathon ship eng\n'
    const blob = await encryptOperatorBlob({
      scope: OPERATOR_BLOB_SCOPES.PROFILE,
      plaintext: new TextEncoder().encode(original),
      precomputedKey: profileKey,
    })
    expect(blob.scope).toBe(OPERATOR_BLOB_SCOPES.PROFILE)
    const wireBytes = encodeOperatorBlobBytes(blob)
    const decoded = decodeOperatorBlobBytes(wireBytes)
    const plaintext = await decryptOperatorBlob({
      scope: OPERATOR_BLOB_SCOPES.PROFILE,
      agentAddress: '0x0000000000000000000000000000000000000000',
      blob: decoded,
      precomputedKey: profileKey,
    })
    expect(new TextDecoder().decode(plaintext)).toBe(original)
  })

  test('wrong precomputedKey fails to decrypt', async () => {
    const correctKey = Buffer.from(randomBytes(32))
    const wrongKey = Buffer.from(randomBytes(32))
    const blob = await encryptOperatorBlob({
      scope: OPERATOR_BLOB_SCOPES.PROFILE,
      plaintext: new TextEncoder().encode('secret'),
      precomputedKey: correctKey,
    })
    let threw = false
    try {
      await decryptOperatorBlob({
        scope: OPERATOR_BLOB_SCOPES.PROFILE,
        agentAddress: '0x0000000000000000000000000000000000000000',
        blob,
        precomputedKey: wrongKey,
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  // v0.23.0 wire check: restoreProfile validates the OperatorBlobScope tag
  // matches PROFILE so a misrouted keystore/telegram blob can't accidentally
  // land as profile content. Same guarantee the legacy paths got post-v0.18.
  test('restoreProfile rejects blob with wrong scope', async () => {
    const profileKey = Buffer.from(randomBytes(32))
    const wrongScopeBlob = await encryptOperatorBlob({
      scope: OPERATOR_BLOB_SCOPES.TELEGRAM,
      plaintext: new TextEncoder().encode('not profile'),
      precomputedKey: profileKey,
    })
    const dir = await mkdtemp(join(tmpdir(), 'anima-profile-roundtrip-'))
    await mkdir(join(dir, 'memory', 'user'), { recursive: true })
    const profilePath = join(dir, 'memory', 'user', 'profile.md')

    const wireBytes = encodeOperatorBlobBytes(wrongScopeBlob)
    const res = await restoreProfile({
      network: '0g-mainnet',
      rootHash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex,
      profileKey,
      profilePath,
      downloadBlob: async () => wireBytes,
    })
    expect(res.status).toBe('failed')
    expect(res.reason).toContain('wrong-scope')
  })

  // The actual restore path: download → decode → decrypt (scope=PROFILE) →
  // write plaintext to profilePath. We inject the downloadBlob stub so no
  // 0G Storage call happens.
  test('restoreProfile happy path writes plaintext to disk', async () => {
    const profileKey = Buffer.from(randomBytes(32))
    const original = '# Profile v0.23.0\n\nuser-partition file, operator-keyed.\n'
    const blob = await encryptOperatorBlob({
      scope: OPERATOR_BLOB_SCOPES.PROFILE,
      plaintext: new TextEncoder().encode(original),
      precomputedKey: profileKey,
    })
    const wireBytes = encodeOperatorBlobBytes(blob)
    const dir = await mkdtemp(join(tmpdir(), 'anima-profile-restore-'))
    await mkdir(join(dir, 'memory', 'user'), { recursive: true })
    const profilePath = join(dir, 'memory', 'user', 'profile.md')

    const res = await restoreProfile({
      network: '0g-mainnet',
      rootHash: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex,
      profileKey,
      profilePath,
      downloadBlob: async () => wireBytes,
    })
    expect(res.status).toBe('restored')
    expect(res.bytes).toBe(original.length)
    expect(await readFile(profilePath, 'utf8')).toBe(original)
  })

  // v0.23.0: syncProfile reports missing-file when profile.md doesn't exist
  // on disk (cold-start sandbox before init seeds). No-op rather than throw.
  test('syncProfile returns missing-file when plaintext is empty', async () => {
    const profileKey = Buffer.from(randomBytes(32))
    const res = await syncProfile({
      network: '0g-mainnet',
      agentPrivkey: generatePrivateKey(),
      profileKey,
      plaintext: new Uint8Array(0),
      lastPlaintextHash: null,
    })
    expect(res.uploaded).toBe(false)
    expect(res.reason).toBe('missing-file')
  })

  test('syncProfile returns no-change when plaintextHash matches lastPlaintextHash', async () => {
    const profileKey = Buffer.from(randomBytes(32))
    const plaintext = new TextEncoder().encode('# Profile\n\nno change expected\n')
    const { keccak256 } = await import('viem')
    const plaintextHash = keccak256(plaintext) as Hex
    const res = await syncProfile({
      network: '0g-mainnet',
      agentPrivkey: generatePrivateKey(),
      profileKey,
      plaintext,
      lastPlaintextHash: plaintextHash,
    })
    expect(res.uploaded).toBe(false)
    expect(res.reason).toBe('no-change')
    expect(res.plaintextHash).toBe(plaintextHash)
  })
})
