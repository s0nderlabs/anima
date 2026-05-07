import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hex } from 'viem'
import {
  DEFAULT_OPERATOR_SESSION_TTL_MS,
  OPERATOR_BLOB_SCOPES,
  OPERATOR_SESSION_VERSION,
  buildOperatorSession,
  clearOperatorSession,
  getSessionKey,
  isOperatorSessionComplete,
  isOperatorSessionFresh,
  operatorSessionPath,
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
