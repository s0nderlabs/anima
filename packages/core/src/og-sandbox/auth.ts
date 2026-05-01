import { type Hex, bytesToHex } from 'viem'
import type { LocalAccount } from 'viem/accounts'

export interface SignedRequest {
  action: string
  expires_at: number
  nonce: string
  payload: Record<string, unknown>
  resource_id: string
}

export type SignedHeaders = {
  'X-Wallet-Address': string
  'X-Signed-Message': string
  'X-Wallet-Signature': Hex
} & Record<string, string>

export interface SignRequestOpts {
  operator: LocalAccount
  action: string
  payload?: Record<string, unknown>
  resourceId?: string
  /** Defaults to now + 60s. Server clamps to (now, now+5min]. */
  expiresAtSec?: number
  /** Override nonce (test fixture). Otherwise crypto-random 16 bytes. */
  nonce?: string
}

/**
 * Build the three EIP-191 auth headers the 0G Sandbox provider expects.
 *
 * Per `0g-sandbox/API_REFERENCE.md`:
 * - The SignedRequest is JSON-serialized in canonical key order
 *   (action, expires_at, nonce, payload, resource_id)
 * - Operator signs the keccak256-prefixed message via personal_sign (EIP-191)
 * - Headers carry: address, base64(JSON), 65-byte sig
 */
export async function signRequest(opts: SignRequestOpts): Promise<SignedHeaders> {
  const expires = opts.expiresAtSec ?? Math.floor(Date.now() / 1000) + 60
  const nonce = opts.nonce ?? randomNonce()
  const req: SignedRequest = {
    action: opts.action,
    expires_at: expires,
    nonce,
    payload: opts.payload ?? {},
    resource_id: opts.resourceId ?? '',
  }
  const json = JSON.stringify(req)
  const signature = await opts.operator.signMessage({ message: json })
  const base64 = base64Encode(json)
  return {
    'X-Wallet-Address': opts.operator.address,
    'X-Signed-Message': base64,
    'X-Wallet-Signature': signature,
  }
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return bytesToHex(bytes).slice(2)
}

function base64Encode(input: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(input, 'utf8').toString('base64')
  if (typeof btoa === 'function') return btoa(input)
  throw new Error('no-base64-impl')
}
