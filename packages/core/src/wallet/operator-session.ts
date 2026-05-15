/**
 * Operator session: a per-agent on-disk cache of the operator-derived AES
 * keys (one per scope) so the headless gateway daemon can boot without
 * prompting Touch ID. Written once via `anima gateway start` after an
 * interactive Touch ID unlock; read by the daemon at boot.
 *
 * Security model:
 *  - File at `~/.anima/agents/<id>/.operator-session` with permission 0600.
 *  - Same threat surface as hermes's `~/.hermes/.env` (which holds API keys
 *    in plaintext for daemon use). An attacker with read access to the user's
 *    home directory can extract these keys and decrypt the agent keystore +
 *    telegram secrets.
 *  - 24-hour default TTL. Caller can override via `expiresInMs`.
 *  - Atomic temp+rename writes.
 *  - The keys themselves are RFC-6979 deterministic — same operator privkey +
 *    same agent address always produce the same key.
 */

import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, bytesToHex, hexToBytes } from 'viem'
import type { OperatorSigner } from '../operator/signer'
import { agentPaths } from '../paths'
import {
  OPERATOR_BLOB_SCOPES,
  type OperatorBlobScope,
  deriveBlobKey,
  deriveKeystoreKey,
  deriveLegacyEmptyDomainKey,
} from './operator-keystore-crypto'

export const OPERATOR_SESSION_VERSION = 1 as const
export const DEFAULT_OPERATOR_SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Plain-object scope-keyed map; `keystore` is the canonical legacy slot. */
export type OperatorSessionKeys = Partial<Record<'keystore' | OperatorBlobScope, Hex>> & {
  keystore: Hex
}

export interface OperatorSession {
  version: typeof OPERATOR_SESSION_VERSION
  agent: Address
  keys: OperatorSessionKeys
  expiresAt: number
  createdAt: number
}

/** Path to the session file for a given agent id. */
export function operatorSessionPath(agentId: string): string {
  return join(agentPaths.agent(agentId).dir, '.operator-session')
}

/**
 * Atomically write the session file at perm 0600. Overwrites any existing
 * session.
 */
export function writeOperatorSession(agentId: string, session: OperatorSession): void {
  const path = operatorSessionPath(agentId)
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
  // rename preserves source perms but be belt-and-suspenders explicit.
  // Wrapped in try/catch for non-POSIX hosts (Windows) where chmod is advisory.
  try {
    chmodSync(path, 0o600)
  } catch {
    /* non-POSIX: permissions are advisory only */
  }
}

/**
 * Read the session file. Returns null when the file is missing, malformed,
 * or expired. Stale sessions are auto-deleted to keep the on-disk surface
 * small.
 */
export function readOperatorSession(agentId: string): OperatorSession | null {
  const path = operatorSessionPath(agentId)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OperatorSession>
    if (parsed.version !== OPERATOR_SESSION_VERSION) return null
    if (typeof parsed.agent !== 'string' || !parsed.agent.startsWith('0x')) return null
    if (typeof parsed.expiresAt !== 'number') return null
    if (typeof parsed.createdAt !== 'number') return null
    if (typeof parsed.keys !== 'object' || parsed.keys === null) return null
    if (typeof parsed.keys.keystore !== 'string') return null
    if (Date.now() > parsed.expiresAt) {
      // Stale; clean up so we don't keep reading expired bytes.
      try {
        unlinkSync(path)
      } catch {
        /* race or perm issue; ignore */
      }
      return null
    }
    return parsed as OperatorSession
  } catch {
    return null
  }
}

/** Best-effort delete; race-tolerant. */
export function clearOperatorSession(agentId: string): void {
  try {
    unlinkSync(operatorSessionPath(agentId))
  } catch {
    /* ENOENT or perm; ignore */
  }
}

/** True if a non-expired session exists on disk. */
export function isOperatorSessionFresh(agentId: string): boolean {
  return readOperatorSession(agentId) !== null
}

/**
 * Map encrypted blob filename → required scope. Extend when new blob types
 * are added so `requiredScopesForAgent` picks them up automatically.
 */
const SCOPE_BLOB_FILES: ReadonlyArray<readonly [filename: string, scope: OperatorBlobScope]> = [
  ['telegram-secrets.encrypted', OPERATOR_BLOB_SCOPES.TELEGRAM],
] as const

/**
 * Map memory-file path → required scope. Used the same way as
 * `SCOPE_BLOB_FILES` but matches on a path under `<agentDir>/memory/` instead
 * of `<agentDir>/`. v0.23.0: the PROFILE slot is operator-keyed, so its scope
 * is required whenever profile.md exists (which is always after init).
 */
const SCOPE_MEMORY_FILES: ReadonlyArray<readonly [path: string, scope: OperatorBlobScope]> = [
  ['memory/user/profile.md', OPERATOR_BLOB_SCOPES.PROFILE],
] as const

/**
 * Inspect the agent dir on disk and return the set of scopes the operator
 * session must contain to fully boot the daemon. Always includes 'keystore'
 * (the canonical legacy slot). Adds extra scopes when their corresponding
 * encrypted blob is present.
 *
 * Used by `anima gateway start` and TUI auto-spawn to decide whether the
 * cached session is "complete enough" or whether re-derivation via Touch ID
 * is needed.
 */
export function requiredScopesForAgent(agentId: string): Array<'keystore' | OperatorBlobScope> {
  const dir = agentPaths.agent(agentId).dir
  const required: Array<'keystore' | OperatorBlobScope> = ['keystore']
  for (const [filename, scope] of SCOPE_BLOB_FILES) {
    if (existsSync(join(dir, filename))) {
      required.push(scope)
    }
  }
  for (const [relPath, scope] of SCOPE_MEMORY_FILES) {
    if (existsSync(join(dir, relPath))) {
      required.push(scope)
    }
  }
  return required
}

/**
 * Stricter sibling of `isOperatorSessionFresh`: true only when (a) a
 * non-expired session exists AND (b) the session contains every scope key
 * required by the agent's on-disk state. A session can be "fresh" by
 * timestamp but missing a scope (e.g. written before telegram-secrets was
 * configured), in which case this returns false so the caller knows to
 * re-derive via Touch ID.
 *
 * The closing the gap on the v0.21.12 regression where `anima gateway start`
 * skipped re-derivation because the session was timestamp-fresh, but the
 * gateway daemon then booted without the TELEGRAM scope key and silently
 * dropped all inbound TG messages.
 */
export function isOperatorSessionComplete(
  agentId: string,
  required: Array<'keystore' | OperatorBlobScope>,
): boolean {
  const sess = readOperatorSession(agentId)
  if (!sess) return false
  for (const scope of required) {
    if (!sess.keys[scope]) return false
  }
  return true
}

/**
 * Pull a key from the session by scope. Returns null when no session exists
 * or the scope is missing. Throws on disk corruption (length mismatch) so
 * silent fallback to Touch ID prompts doesn't mask data integrity bugs.
 */
export function getSessionKey(
  agentId: string,
  which: 'keystore' | OperatorBlobScope,
): Buffer | null {
  const sess = readOperatorSession(agentId)
  if (!sess) return null
  const hex = sess.keys[which]
  if (!hex) return null
  const buf = Buffer.from(hexToBytes(hex))
  if (buf.length !== 32) {
    throw new Error(
      `operator-session: corrupt key for scope '${which}' (length ${buf.length}, expected 32)`,
    )
  }
  return buf
}

/**
 * Optional verifier called by `precomputeAllScopes` after each scope's
 * canonical key is derived. Returning false triggers the v0.24.10 legacy
 * empty-EIP712Domain fallback for that scope (and propagates legacy
 * derivation to any later scope keys, since the EIP712Domain trap is a
 * signer-wide property, not a per-scope one).
 */
export type PrecomputeVerifyKey = (
  scope: 'keystore' | OperatorBlobScope,
  key: Buffer,
) => boolean | Promise<boolean>

export interface PrecomputeAllScopesOpts {
  /**
   * v0.24.10: Optional verifier. When unset, `precomputeAllScopes` behaves
   * exactly as it did in v0.24.9 (parallel canonical-only derivation). When
   * set, the verifier runs after each derive — failure swaps to the legacy
   * variant via the signer's `signTypedDataLegacyEmptyDomain` escape hatch.
   *
   * The verifier is supplied by the caller because it owns the disk layout:
   * gateway-start verifies against `keystore.json` + `telegram-secrets.encrypted`
   * on disk; `init` doesn't pass a verifier because the keystore is being
   * freshly encrypted under the just-derived canonical key.
   */
  verifyKey?: PrecomputeVerifyKey
}

/**
 * Derive all requested scope keys from the operator signer in parallel.
 * Each derive triggers `signer.signTypedData`. Many signer backends (keychain)
 * serialize the underlying transport, so parallel is a free win for backends
 * that don't (raw-privkey, in-memory) and a no-op for those that do.
 *
 * `extraScopes` — additional scopes to derive beyond the always-on
 * `keystore`. Phase 12 telegram passes [OPERATOR_BLOB_SCOPES.TELEGRAM];
 * v0.23.0 PROFILE adds [OPERATOR_BLOB_SCOPES.PROFILE] when the agent's
 * user-partition memory exists.
 *
 * v0.24.10: when `opts.verifyKey` is supplied, the keystore canonical key is
 * trial-decrypted against the on-disk blob; if the verifier rejects it, the
 * signer's `signTypedDataLegacyEmptyDomain` escape hatch is invoked to derive
 * the pre-v0.24.9 WC variant. The detection cascades to remaining scopes —
 * once the signer is known to be in legacy mode, every scope key is derived
 * via the legacy method so the daemon boots with keys that actually decrypt
 * the on-disk artifacts (single MM popup per scope on the first launch
 * post-v0.24.9 for legacy WC agents; canonical-success agents see zero
 * behavior change).
 */
export async function precomputeAllScopes(
  signer: OperatorSigner,
  agent: Address,
  extraScopes: OperatorBlobScope[] = [],
  opts: PrecomputeAllScopesOpts = {},
): Promise<OperatorSessionKeys> {
  if (!opts.verifyKey) {
    const [keystore, ...extras] = await Promise.all([
      deriveKeystoreKey(signer, agent),
      ...extraScopes.map(scope => deriveBlobKey(signer, agent, scope)),
    ])
    const result: OperatorSessionKeys = { keystore: bytesToHex(keystore) }
    extraScopes.forEach((scope, i) => {
      const buf = extras[i]
      if (buf) result[scope] = bytesToHex(buf)
    })
    return result
  }

  // Verify-and-swap path. Serialize keystore first so the legacy detection
  // cascades to remaining scopes uniformly.
  const verifyKey = opts.verifyKey
  let keystoreKey = await deriveKeystoreKey(signer, agent)
  let useLegacyForRest = false
  if (!(await verifyKey('keystore', keystoreKey))) {
    const legacyKey = await deriveLegacyEmptyDomainKey(signer, agent, 'keystore')
    if (!legacyKey) {
      throw new Error(
        'precomputeAllScopes: keystore decrypt verification failed with canonical key and signer does not expose a legacy variant. Verify the operator wallet matches the agent keystore.',
      )
    }
    if (!(await verifyKey('keystore', legacyKey))) {
      throw new Error(
        'precomputeAllScopes: keystore decrypt verification failed with both canonical and legacy variants. The operator wallet may not match the agent keystore.',
      )
    }
    keystoreKey = legacyKey
    useLegacyForRest = true
  }

  const extras = await Promise.all(
    extraScopes.map(async (scope): Promise<{ scope: OperatorBlobScope; key: Buffer | null }> => {
      let key: Buffer | null = useLegacyForRest
        ? await deriveLegacyEmptyDomainKey(signer, agent, scope)
        : await deriveBlobKey(signer, agent, scope)
      if (key && !(await verifyKey(scope, key))) {
        const altKey: Buffer | null = useLegacyForRest
          ? await deriveBlobKey(signer, agent, scope)
          : await deriveLegacyEmptyDomainKey(signer, agent, scope)
        if (altKey && (await verifyKey(scope, altKey))) {
          key = altKey
        } else {
          key = null
        }
      }
      return { scope, key }
    }),
  )

  const result: OperatorSessionKeys = { keystore: bytesToHex(keystoreKey) }
  for (const { scope, key } of extras) {
    if (key) result[scope] = bytesToHex(key)
  }
  return result
}

/**
 * Build an OperatorSession from a keys object plus an optional TTL override.
 * Convenience composer used by `anima gateway start`.
 */
export function buildOperatorSession(opts: {
  agent: Address
  keys: OperatorSessionKeys
  expiresInMs?: number
}): OperatorSession {
  const now = Date.now()
  const ttl = opts.expiresInMs ?? DEFAULT_OPERATOR_SESSION_TTL_MS
  return {
    version: OPERATOR_SESSION_VERSION,
    agent: opts.agent,
    keys: opts.keys,
    expiresAt: now + ttl,
    createdAt: now,
  }
}
