import {
  type Address,
  type Hex,
  encodeAbiParameters,
  isAddressEqual,
  keccak256,
  recoverMessageAddress,
} from 'viem'
import type { RuntimeConfig } from './runtime'
import type { INFTRef } from './state'

export interface ProvisionEnvelope {
  ephPubkeyHex: Hex
  ivHex: Hex
  tagHex: Hex
  ciphertextHex: Hex
}

export interface ProvisionRequest {
  envelope: ProvisionEnvelope
  /**
   * Optional second ECIES envelope sealing the harness secrets JSON
   * (telegram bot token + allowlist, etc.). Sealed to the same bootstrap
   * pubkey. The operator's signature covers both envelopes so a stolen
   * secrets envelope can't be replayed against a different harness.
   */
  secretsEnvelope?: ProvisionEnvelope
  operatorAddress: Address
  iNFTRef: INFTRef
  config: RuntimeConfig
  ts: number
}

function envelopeHash(env: ProvisionEnvelope): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes', name: 'eph' },
        { type: 'bytes', name: 'iv' },
        { type: 'bytes', name: 'tag' },
        { type: 'bytes', name: 'ct' },
      ],
      [env.ephPubkeyHex, env.ivHex, env.tagHex, env.ciphertextHex],
    ),
  )
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  // Skip undefined-valued keys to match `JSON.stringify` semantics. Critical
  // because the wire path is `JSON.stringify` → JSON.parse, which silently
  // drops undefined object values. If we hashed them as the literal text
  // `undefined`, the CLI's pre-wire hash and the harness's post-wire hash
  // would diverge for any optional field the caller leaves unset (e.g.
  // `RuntimeConfig.promptAppend`), surfacing as `provision-rejected: sig-mismatch`.
  const v = value as Record<string, unknown>
  const keys = Object.keys(v)
    .filter(k => v[k] !== undefined)
    .sort()
  const props = keys.map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
  return `{${props.join(',')}}`
}

function configHash(config: RuntimeConfig): Hex {
  // Stable JSON via recursive key-sorted stringify; harness + client must agree.
  const stable = stableStringify(config)
  return keccak256(`0x${Buffer.from(stable, 'utf8').toString('hex')}` as Hex)
}

/**
 * Build the deterministic digest the operator signs over. Anchored to the
 * harness bootstrap pubkey + config hash so a stolen envelope cannot be replayed
 * against a different harness or a different runtime config.
 */
export function provisionMessageHash(req: ProvisionRequest, bootstrapPubkey: Hex): Hex {
  // v0.18+ extends the digest with a secretsEnvelopeHash so a second envelope
  // can ship telegram secrets etc. alongside the agent privkey. Zero-hash
  // sentinel preserves the v0.17 digest when no secrets envelope is sent.
  const secretsHash: Hex = req.secretsEnvelope
    ? envelopeHash(req.secretsEnvelope)
    : ('0x0000000000000000000000000000000000000000000000000000000000000000' as Hex)
  const encoded = encodeAbiParameters(
    [
      { type: 'bytes32', name: 'envelopeHash' },
      { type: 'bytes32', name: 'secretsEnvelopeHash' },
      { type: 'bytes32', name: 'configHash' },
      { type: 'address', name: 'operator' },
      { type: 'address', name: 'inftContract' },
      { type: 'uint256', name: 'tokenId' },
      { type: 'uint64', name: 'ts' },
      { type: 'bytes', name: 'bootstrapPubkey' },
    ],
    [
      envelopeHash(req.envelope),
      secretsHash,
      configHash(req.config),
      req.operatorAddress,
      req.iNFTRef.contract,
      BigInt(req.iNFTRef.tokenId),
      BigInt(req.ts),
      bootstrapPubkey,
    ],
  )
  return keccak256(encoded)
}

export interface VerifyOpts {
  request: ProvisionRequest
  signature: Hex
  bootstrapPubkey: Hex
  expectedOperator: Address
  /** Reject ts older than this (default 5min). */
  maxAgeMs?: number
  /** Reject ts further into the future than this (default 1min for clock skew). */
  maxFutureMs?: number
  now?: number
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

export async function verifyProvisionSig(opts: VerifyOpts): Promise<VerifyResult> {
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000
  const maxFuture = opts.maxFutureMs ?? 60 * 1000

  if (!isAddressEqual(opts.request.operatorAddress, opts.expectedOperator)) {
    return { ok: false, reason: 'operator-mismatch' }
  }
  if (opts.request.ts > now + maxFuture) {
    return { ok: false, reason: 'ts-future' }
  }
  if (opts.request.ts < now - maxAge) {
    return { ok: false, reason: 'ts-stale' }
  }

  const hash = provisionMessageHash(opts.request, opts.bootstrapPubkey)
  let recovered: Address
  try {
    recovered = await recoverMessageAddress({ message: { raw: hash }, signature: opts.signature })
  } catch (e) {
    return { ok: false, reason: `sig-decode: ${(e as Error).message}` }
  }

  if (!isAddressEqual(recovered, opts.expectedOperator)) {
    return { ok: false, reason: 'sig-mismatch' }
  }

  return { ok: true }
}

/**
 * Hash the operator signs to authenticate a chat message turn. Anchored to
 * sandboxId so a chat sig cannot be replayed against a different sandbox
 * harness running on the same operator.
 */
export function chatMessageHash(message: string, ts: number, sandboxId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string', name: 'message' },
        { type: 'uint64', name: 'ts' },
        { type: 'string', name: 'sandboxId' },
      ],
      [message, BigInt(ts), sandboxId],
    ),
  )
}

export interface VerifyChatOpts {
  message: string
  ts: number
  sandboxId: string
  signature: Hex
  expectedOperator: Address
  maxAgeMs?: number
  maxFutureMs?: number
  now?: number
}

export async function verifyChatSig(opts: VerifyChatOpts): Promise<VerifyResult> {
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000
  const maxFuture = opts.maxFutureMs ?? 60 * 1000
  if (opts.ts > now + maxFuture) return { ok: false, reason: 'ts-future' }
  if (opts.ts < now - maxAge) return { ok: false, reason: 'ts-stale' }

  const hash = chatMessageHash(opts.message, opts.ts, opts.sandboxId)
  let recovered: Address
  try {
    recovered = await recoverMessageAddress({ message: { raw: hash }, signature: opts.signature })
  } catch (e) {
    return { ok: false, reason: `sig-decode: ${(e as Error).message}` }
  }
  if (!isAddressEqual(recovered, opts.expectedOperator)) {
    return { ok: false, reason: 'sig-mismatch' }
  }
  return { ok: true }
}

/**
 * v0.21.9: hash the operator signs to authenticate an admin tick (e.g.
 * `POST /admin/autotopup/tick`) against the sandbox endpoint. Anchored to
 * `action` + `sandboxId` so a sig for one admin endpoint can't be replayed
 * against another, and the `chat`/`approval` sig spaces stay isolated from
 * admin operations. Pattern mirrors `chatMessageHash` / `approvalResponseHash`.
 *
 * v0.24.4: `AdminAction` is a documentation-only union of actions currently
 * accepted by sandbox endpoints. The hash + verifier accept arbitrary
 * strings (so cross-action replay tests can sign non-existent actions); the
 * allowlist is enforced at the route layer in `server.ts`. Add new admin
 * endpoints here so call-site authors can grep for the canonical name.
 *
 *   - 'autotopup-tick'  → POST /admin/autotopup/tick
 *   - 'profile-key'     → POST /admin/profile-key
 *   - 'pairing-approve' → POST /admin/pairing/approve
 */
export type AdminAction = 'autotopup-tick' | 'profile-key' | 'pairing-approve'

export function adminTickHash(opts: {
  action: AdminAction | string
  ts: number
  sandboxId: string
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string', name: 'action' },
        { type: 'uint64', name: 'ts' },
        { type: 'string', name: 'sandboxId' },
      ],
      [opts.action, BigInt(opts.ts), opts.sandboxId],
    ),
  )
}

export interface VerifyAdminTickOpts {
  action: AdminAction | string
  ts: number
  sandboxId: string
  signature: Hex
  expectedOperator: Address
  maxAgeMs?: number
  maxFutureMs?: number
  now?: number
}

export async function verifyAdminTickSig(opts: VerifyAdminTickOpts): Promise<VerifyResult> {
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000
  const maxFuture = opts.maxFutureMs ?? 60 * 1000
  if (opts.ts > now + maxFuture) return { ok: false, reason: 'ts-future' }
  if (opts.ts < now - maxAge) return { ok: false, reason: 'ts-stale' }

  const hash = adminTickHash({
    action: opts.action,
    ts: opts.ts,
    sandboxId: opts.sandboxId,
  })
  let recovered: Address
  try {
    recovered = await recoverMessageAddress({ message: { raw: hash }, signature: opts.signature })
  } catch (e) {
    return { ok: false, reason: `sig-decode: ${(e as Error).message}` }
  }
  if (!isAddressEqual(recovered, opts.expectedOperator)) {
    return { ok: false, reason: 'sig-mismatch' }
  }
  return { ok: true }
}

/**
 * Hash the operator signs for an approval response.
 */
export function approvalResponseHash(opts: {
  approvalId: string
  decision: 'allow' | 'allow-session' | 'deny'
  ts: number
  sandboxId: string
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string', name: 'approvalId' },
        { type: 'string', name: 'decision' },
        { type: 'uint64', name: 'ts' },
        { type: 'string', name: 'sandboxId' },
      ],
      [opts.approvalId, opts.decision, BigInt(opts.ts), opts.sandboxId],
    ),
  )
}

export interface VerifyApprovalOpts {
  approvalId: string
  decision: 'allow' | 'allow-session' | 'deny'
  ts: number
  sandboxId: string
  signature: Hex
  expectedOperator: Address
  maxAgeMs?: number
  maxFutureMs?: number
  now?: number
}

export async function verifyApprovalSig(opts: VerifyApprovalOpts): Promise<VerifyResult> {
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000
  const maxFuture = opts.maxFutureMs ?? 60 * 1000
  if (opts.ts > now + maxFuture) return { ok: false, reason: 'ts-future' }
  if (opts.ts < now - maxAge) return { ok: false, reason: 'ts-stale' }

  const hash = approvalResponseHash({
    approvalId: opts.approvalId,
    decision: opts.decision,
    ts: opts.ts,
    sandboxId: opts.sandboxId,
  })
  let recovered: Address
  try {
    recovered = await recoverMessageAddress({ message: { raw: hash }, signature: opts.signature })
  } catch (e) {
    return { ok: false, reason: `sig-decode: ${(e as Error).message}` }
  }
  if (!isAddressEqual(recovered, opts.expectedOperator)) {
    return { ok: false, reason: 'sig-mismatch' }
  }
  return { ok: true }
}
