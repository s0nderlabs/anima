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

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, bytesToHex, hexToBytes } from 'viem'
import type { OperatorSigner } from '../operator/signer'
import { agentPaths } from '../paths'
import {
  type OperatorBlobScope,
  deriveBlobKey,
  deriveKeystoreKey,
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
 * Derive all requested scope keys from the operator signer in parallel.
 * Each derive triggers `signer.signTypedData`. Many signer backends (keychain)
 * serialize the underlying transport, so parallel is a free win for backends
 * that don't (raw-privkey, in-memory) and a no-op for those that do.
 *
 * `extraScopes` — additional scopes to derive beyond the always-on
 * `keystore`. Phase 12 telegram passes [OPERATOR_BLOB_SCOPES.TELEGRAM].
 */
export async function precomputeAllScopes(
  signer: OperatorSigner,
  agent: Address,
  extraScopes: OperatorBlobScope[] = [],
): Promise<OperatorSessionKeys> {
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
