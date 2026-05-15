import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
  bytesToHex,
} from 'viem'
import {
  type PrivateKeyAccount,
  generatePrivateKey,
  privateKeyToAccount,
  toAccount,
} from 'viem/accounts'
import { RawPrivkeyOperatorSigner } from '../operator/raw-privkey'
import type { OperatorSigner } from '../operator/signer'
import {
  DEFAULT_OPERATOR_SESSION_TTL_MS,
  OPERATOR_BLOB_SCOPES,
  OPERATOR_SESSION_VERSION,
  buildOperatorSession,
  clearOperatorSession,
  deriveBlobKey,
  deriveKeystoreKey,
  getSessionKey,
  isOperatorSessionComplete,
  isOperatorSessionFresh,
  operatorSessionPath,
  precomputeAllScopes,
  readOperatorSession,
  requiredScopesForAgent,
  writeOperatorSession,
} from './index'

// Pin agentPaths to a tmp dir via ANIMA_ROOT (paths.ts respects this).
const TEST_AGENT_ID = 'feedfeedfeedfeed'
const ORIGINAL_ANIMA_ROOT = process.env.ANIMA_ROOT

const hex32 = (byte: number): Hex => `0x${byte.toString(16).padStart(2, '0').repeat(32)}` as Hex

beforeEach(() => {
  const tmp = join(tmpdir(), `anima-op-session-test-${process.pid}-${Date.now().toString(36)}`)
  mkdirSync(join(tmp, 'agents', TEST_AGENT_ID), { recursive: true })
  process.env.ANIMA_ROOT = tmp
})

afterEach(() => {
  if (process.env.ANIMA_ROOT?.includes('anima-op-session-test')) {
    try {
      rmSync(process.env.ANIMA_ROOT, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  if (ORIGINAL_ANIMA_ROOT === undefined) process.env.ANIMA_ROOT = undefined
  else process.env.ANIMA_ROOT = ORIGINAL_ANIMA_ROOT
})

describe('operatorSessionPath', () => {
  test('returns ~/.anima/agents/<id>/.operator-session', () => {
    const p = operatorSessionPath(TEST_AGENT_ID)
    expect(p.endsWith(`/agents/${TEST_AGENT_ID}/.operator-session`)).toBe(true)
  })
})

describe('writeOperatorSession + readOperatorSession', () => {
  test('round-trips a session', () => {
    const sess = buildOperatorSession({
      agent: '0x0000000000000000000000000000000000000001',
      keys: { keystore: hex32(0xaa) },
    })
    writeOperatorSession(TEST_AGENT_ID, sess)
    const got = readOperatorSession(TEST_AGENT_ID)
    expect(got).not.toBeNull()
    expect(got?.agent).toBe(sess.agent)
    expect(got?.keys.keystore).toBe(sess.keys.keystore)
    expect(got?.expiresAt).toBe(sess.expiresAt)
    expect(got?.version).toBe(OPERATOR_SESSION_VERSION)
  })

  test('writes file at perm 0600', () => {
    const sess = buildOperatorSession({
      agent: '0x0000000000000000000000000000000000000001',
      keys: { keystore: hex32(0xbb) },
    })
    writeOperatorSession(TEST_AGENT_ID, sess)
    const stat = statSync(operatorSessionPath(TEST_AGENT_ID))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test('returns null when file does not exist', () => {
    expect(readOperatorSession(TEST_AGENT_ID)).toBeNull()
  })

  test('returns null + cleans up when expired', () => {
    const sess: ReturnType<typeof buildOperatorSession> = {
      version: OPERATOR_SESSION_VERSION,
      agent: '0x0000000000000000000000000000000000000001',
      keys: { keystore: hex32(0xcc) },
      expiresAt: Date.now() - 1000,
      createdAt: Date.now() - 5000,
    }
    writeOperatorSession(TEST_AGENT_ID, sess)
    expect(existsSync(operatorSessionPath(TEST_AGENT_ID))).toBe(true)
    const got = readOperatorSession(TEST_AGENT_ID)
    expect(got).toBeNull()
    expect(existsSync(operatorSessionPath(TEST_AGENT_ID))).toBe(false)
  })

  test('returns null on malformed JSON', async () => {
    const path = operatorSessionPath(TEST_AGENT_ID)
    await Bun.write(path, '{not-json')
    expect(readOperatorSession(TEST_AGENT_ID)).toBeNull()
  })

  test('returns null on wrong version', async () => {
    const path = operatorSessionPath(TEST_AGENT_ID)
    await Bun.write(
      path,
      JSON.stringify({ version: 99, agent: '0x', keys: {}, expiresAt: 0, createdAt: 0 }),
    )
    expect(readOperatorSession(TEST_AGENT_ID)).toBeNull()
  })
})

describe('isOperatorSessionFresh', () => {
  test('false when no session', () => {
    expect(isOperatorSessionFresh(TEST_AGENT_ID)).toBe(false)
  })

  test('true after writing fresh session', () => {
    writeOperatorSession(
      TEST_AGENT_ID,
      buildOperatorSession({
        agent: '0x0000000000000000000000000000000000000002',
        keys: { keystore: hex32(0xdd) },
      }),
    )
    expect(isOperatorSessionFresh(TEST_AGENT_ID)).toBe(true)
  })
})

describe('clearOperatorSession', () => {
  test('removes existing session file', () => {
    writeOperatorSession(
      TEST_AGENT_ID,
      buildOperatorSession({
        agent: '0x0000000000000000000000000000000000000003',
        keys: { keystore: hex32(0xee) },
      }),
    )
    expect(existsSync(operatorSessionPath(TEST_AGENT_ID))).toBe(true)
    clearOperatorSession(TEST_AGENT_ID)
    expect(existsSync(operatorSessionPath(TEST_AGENT_ID))).toBe(false)
  })

  test('no-op when file does not exist', () => {
    expect(() => clearOperatorSession(TEST_AGENT_ID)).not.toThrow()
  })
})

describe('getSessionKey', () => {
  test('retrieves keystore key as 32-byte Buffer', () => {
    writeOperatorSession(
      TEST_AGENT_ID,
      buildOperatorSession({
        agent: '0x0000000000000000000000000000000000000004',
        keys: { keystore: hex32(0xff) },
      }),
    )
    const got = getSessionKey(TEST_AGENT_ID, 'keystore')
    expect(got).not.toBeNull()
    expect(got?.length).toBe(32)
    expect(got?.equals(Buffer.alloc(32, 0xff))).toBe(true)
  })

  test('retrieves scope key (telegram)', () => {
    writeOperatorSession(
      TEST_AGENT_ID,
      buildOperatorSession({
        agent: '0x0000000000000000000000000000000000000005',
        keys: { keystore: hex32(0xa0), [OPERATOR_BLOB_SCOPES.TELEGRAM]: hex32(0xa1) },
      }),
    )
    const got = getSessionKey(TEST_AGENT_ID, OPERATOR_BLOB_SCOPES.TELEGRAM)
    expect(got).not.toBeNull()
    expect(got?.equals(Buffer.alloc(32, 0xa1))).toBe(true)
  })

  test('returns null for missing scope', () => {
    writeOperatorSession(
      TEST_AGENT_ID,
      buildOperatorSession({
        agent: '0x0000000000000000000000000000000000000006',
        keys: { keystore: hex32(0) },
      }),
    )
    expect(getSessionKey(TEST_AGENT_ID, 'nonexistent-scope')).toBeNull()
  })

  test('returns null when no session at all', () => {
    expect(getSessionKey(TEST_AGENT_ID, 'keystore')).toBeNull()
  })

  test('throws on corrupt key length (not 32 bytes)', () => {
    writeOperatorSession(
      TEST_AGENT_ID,
      buildOperatorSession({
        agent: '0x0000000000000000000000000000000000000007',
        keys: { keystore: '0xdeadbeef' as Hex },
      }),
    )
    expect(() => getSessionKey(TEST_AGENT_ID, 'keystore')).toThrow(/corrupt key/)
  })
})

describe('buildOperatorSession', () => {
  test('default TTL is 24h', () => {
    const before = Date.now()
    const sess = buildOperatorSession({
      agent: '0x0000000000000000000000000000000000000007',
      keys: { keystore: hex32(0) },
    })
    const after = Date.now()
    const expected = before + DEFAULT_OPERATOR_SESSION_TTL_MS
    const slop = 100
    expect(sess.expiresAt).toBeGreaterThanOrEqual(expected - slop)
    expect(sess.expiresAt).toBeLessThanOrEqual(after + DEFAULT_OPERATOR_SESSION_TTL_MS + slop)
  })

  test('custom TTL respected', () => {
    const sess = buildOperatorSession({
      agent: '0x0000000000000000000000000000000000000008',
      keys: { keystore: hex32(0) },
      expiresInMs: 60_000,
    })
    expect(sess.expiresAt - sess.createdAt).toBeLessThanOrEqual(60_000 + 100)
  })

  test('preserves all scope keys provided', () => {
    const sess = buildOperatorSession({
      agent: '0x0000000000000000000000000000000000000009',
      keys: { keystore: hex32(1), [OPERATOR_BLOB_SCOPES.TELEGRAM]: hex32(2) },
    })
    expect(sess.keys.keystore).toBe(hex32(1))
    expect(sess.keys[OPERATOR_BLOB_SCOPES.TELEGRAM]).toBe(hex32(2))
  })
})

describe('v0.21.12: requiredScopesForAgent + isOperatorSessionComplete', () => {
  test('requiredScopesForAgent returns only keystore when no encrypted blobs exist', () => {
    const required = requiredScopesForAgent(TEST_AGENT_ID)
    expect(required).toEqual(['keystore'])
  })

  test('requiredScopesForAgent adds telegram scope when telegram-secrets.encrypted exists', () => {
    const dir = join(process.env.ANIMA_ROOT ?? '', 'agents', TEST_AGENT_ID)
    writeFileSync(join(dir, 'telegram-secrets.encrypted'), Buffer.from('placeholder'))
    const required = requiredScopesForAgent(TEST_AGENT_ID)
    expect(required).toEqual(['keystore', OPERATOR_BLOB_SCOPES.TELEGRAM])
  })

  test('isOperatorSessionComplete returns false when no session exists', () => {
    expect(isOperatorSessionComplete(TEST_AGENT_ID, ['keystore'])).toBe(false)
  })

  test('isOperatorSessionComplete returns true when session has all required scopes', () => {
    const sess = buildOperatorSession({
      agent: '0x0000000000000000000000000000000000000010',
      keys: { keystore: hex32(1), [OPERATOR_BLOB_SCOPES.TELEGRAM]: hex32(2) },
    })
    writeOperatorSession(TEST_AGENT_ID, sess)
    expect(
      isOperatorSessionComplete(TEST_AGENT_ID, ['keystore', OPERATOR_BLOB_SCOPES.TELEGRAM]),
    ).toBe(true)
  })

  test('isOperatorSessionComplete returns FALSE when session is fresh but missing a required scope', () => {
    // The exact regression we shipped v0.21.12 to close: timestamp-fresh but
    // missing telegram scope key. isOperatorSessionFresh would return true,
    // isOperatorSessionComplete must return false so the caller re-derives.
    const sess = buildOperatorSession({
      agent: '0x0000000000000000000000000000000000000011',
      keys: { keystore: hex32(1) }, // no TELEGRAM scope
    })
    writeOperatorSession(TEST_AGENT_ID, sess)
    expect(isOperatorSessionFresh(TEST_AGENT_ID)).toBe(true)
    expect(
      isOperatorSessionComplete(TEST_AGENT_ID, ['keystore', OPERATOR_BLOB_SCOPES.TELEGRAM]),
    ).toBe(false)
  })

  test('isOperatorSessionComplete tolerates expired session by returning false', () => {
    const sess = buildOperatorSession({
      agent: '0x0000000000000000000000000000000000000012',
      keys: { keystore: hex32(1), [OPERATOR_BLOB_SCOPES.TELEGRAM]: hex32(2) },
      expiresInMs: 1, // immediately expired
    })
    writeOperatorSession(TEST_AGENT_ID, sess)
    // Wait a tick to ensure expiry registers.
    const expired = new Promise<void>(r => setTimeout(r, 10))
    return expired.then(() => {
      expect(
        isOperatorSessionComplete(TEST_AGENT_ID, ['keystore', OPERATOR_BLOB_SCOPES.TELEGRAM]),
      ).toBe(false)
    })
  })
})

// -- v0.24.10 precomputeAllScopes verify-and-swap ---------------------------

/**
 * Same dual-variant signer pattern as operator-keystore-crypto.test.ts. The
 * mock backs `signTypedData` with privkey A (canonical hash) and
 * `signTypedDataLegacyEmptyDomain` with privkey B (pre-v0.24.9 WC variant).
 * That gives us two genuinely different ECDSA sigs from one signer, which is
 * exactly the divergence we need to exercise the verify-and-swap path.
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

describe('v0.24.10: precomputeAllScopes verify-and-swap', () => {
  test('without verifyKey: parallel canonical-only derivation (LocalAccount happy path)', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const keys = await precomputeAllScopes(signer, agent, [
      OPERATOR_BLOB_SCOPES.PROFILE,
      OPERATOR_BLOB_SCOPES.TELEGRAM,
    ])
    // Both extras present + match direct derive.
    expect(keys.keystore).toBe(bytesToHex(await deriveKeystoreKey(signer, agent)))
    expect(keys[OPERATOR_BLOB_SCOPES.PROFILE]).toBe(
      bytesToHex(await deriveBlobKey(signer, agent, OPERATOR_BLOB_SCOPES.PROFILE)),
    )
    expect(keys[OPERATOR_BLOB_SCOPES.TELEGRAM]).toBe(
      bytesToHex(await deriveBlobKey(signer, agent, OPERATOR_BLOB_SCOPES.TELEGRAM)),
    )
  })

  test('verifyKey passes canonical (LocalAccount): keystore cached as canonical, no legacy invocation', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const canonicalKeystoreKey = await deriveKeystoreKey(signer, agent)

    let verifyCalls = 0
    const verifyKey = async (scope: string, key: Buffer): Promise<boolean> => {
      verifyCalls++
      // Verifier "knows" the right canonical key for keystore + PROFILE.
      if (scope === 'keystore') return key.equals(canonicalKeystoreKey)
      if (scope === OPERATOR_BLOB_SCOPES.PROFILE) {
        const profileKey = await deriveBlobKey(signer, agent, OPERATOR_BLOB_SCOPES.PROFILE)
        return key.equals(profileKey)
      }
      return true
    }
    const keys = await precomputeAllScopes(signer, agent, [OPERATOR_BLOB_SCOPES.PROFILE], {
      verifyKey,
    })
    expect(keys.keystore).toBe(bytesToHex(canonicalKeystoreKey))
    expect(keys[OPERATOR_BLOB_SCOPES.PROFILE]).toBeDefined()
    expect(verifyCalls).toBeGreaterThanOrEqual(2) // at least keystore + profile
  })

  test('verifyKey rejects canonical, dual signer swaps to legacy: keystore + PROFILE both cached as legacy (fox scenario)', async () => {
    const canonicalPrivkey = generatePrivateKey()
    const legacyPrivkey = generatePrivateKey()
    const canonicalAcct = privateKeyToAccount(canonicalPrivkey)
    const legacyAcct = privateKeyToAccount(legacyPrivkey)
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const dualSigner = new MockDualVariantSigner(canonicalAcct, legacyAcct)

    // The "on-disk" keystore + PROFILE blob are bound to LEGACY privkey's
    // signature (pre-v0.24.9 WC encrypted everything with the empty-domain
    // hash). Compute the legacy-variant keys directly via a raw-privkey
    // signer running on the legacy privkey.
    const legacyDirectSigner = new RawPrivkeyOperatorSigner({ privkey: legacyPrivkey })
    const legacyKeystoreKey = await deriveKeystoreKey(legacyDirectSigner, agent)
    const legacyProfileKey = await deriveBlobKey(
      legacyDirectSigner,
      agent,
      OPERATOR_BLOB_SCOPES.PROFILE,
    )

    // The verifier knows the legacy-variant keys are what decrypt the
    // on-disk artifacts. Canonical fails, legacy passes.
    const verifyKey = async (scope: string, key: Buffer): Promise<boolean> => {
      if (scope === 'keystore') return key.equals(legacyKeystoreKey)
      if (scope === OPERATOR_BLOB_SCOPES.PROFILE) return key.equals(legacyProfileKey)
      return true
    }

    const keys = await precomputeAllScopes(dualSigner, agent, [OPERATOR_BLOB_SCOPES.PROFILE], {
      verifyKey,
    })
    expect(keys.keystore).toBe(bytesToHex(legacyKeystoreKey))
    expect(keys[OPERATOR_BLOB_SCOPES.PROFILE]).toBe(bytesToHex(legacyProfileKey))
  })

  test('verifyKey rejects canonical, signer has NO legacy escape: throws (LocalAccount with wrong wallet)', async () => {
    const signer = new RawPrivkeyOperatorSigner({ privkey: generatePrivateKey() })
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const verifyKey = async (_scope: string, _key: Buffer): Promise<boolean> => false
    await expect(
      precomputeAllScopes(signer, agent, [OPERATOR_BLOB_SCOPES.PROFILE], { verifyKey }),
    ).rejects.toThrow(/canonical key and signer does not expose a legacy variant/)
  })

  test('verifyKey rejects canonical AND legacy: throws (truly wrong operator)', async () => {
    const canonicalAcct = privateKeyToAccount(generatePrivateKey())
    const legacyAcct = privateKeyToAccount(generatePrivateKey())
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const dualSigner = new MockDualVariantSigner(canonicalAcct, legacyAcct)
    const verifyKey = async (_scope: string, _key: Buffer): Promise<boolean> => false
    await expect(precomputeAllScopes(dualSigner, agent, [], { verifyKey })).rejects.toThrow(
      /both canonical and legacy variants/,
    )
  })

  test('verifyKey path with no extra scopes still cascades legacy detection (keystore-only swap)', async () => {
    const canonicalPrivkey = generatePrivateKey()
    const legacyPrivkey = generatePrivateKey()
    const canonicalAcct = privateKeyToAccount(canonicalPrivkey)
    const legacyAcct = privateKeyToAccount(legacyPrivkey)
    const agent = privateKeyToAccount(generatePrivateKey()).address
    const dualSigner = new MockDualVariantSigner(canonicalAcct, legacyAcct)
    const legacyDirectSigner = new RawPrivkeyOperatorSigner({ privkey: legacyPrivkey })
    const legacyKeystoreKey = await deriveKeystoreKey(legacyDirectSigner, agent)
    const verifyKey = async (scope: string, key: Buffer): Promise<boolean> =>
      scope === 'keystore' && key.equals(legacyKeystoreKey)
    const keys = await precomputeAllScopes(dualSigner, agent, [], { verifyKey })
    expect(keys.keystore).toBe(bytesToHex(legacyKeystoreKey))
  })
})
