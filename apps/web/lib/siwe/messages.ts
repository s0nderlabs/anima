// SIWE message construction + verification via viem.

import 'server-only'
import { http, type Address, type Hex, createPublicClient } from 'viem'
import { type SiweMessage, parseSiweMessage, verifySiweMessage } from 'viem/siwe'
import { zgMainnet } from '../chain/chain'

const publicClient = createPublicClient({
  chain: zgMainnet,
  transport: http(),
})

export function buildSiweMessage(opts: {
  address: Address
  chainId: number
  nonce: string
  domain: string
  uri: string
  issuedAt?: string
}): string {
  const statement =
    'Sign in to the Anima console. This signature proves wallet ownership and creates a session cookie. No transactions are sent.'
  const issuedAt = opts.issuedAt ?? new Date().toISOString()
  return [
    `${opts.domain} wants you to sign in with your Ethereum account:`,
    opts.address,
    '',
    statement,
    '',
    `URI: ${opts.uri}`,
    'Version: 1',
    `Chain ID: ${opts.chainId}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n')
}

export type SiweVerifyResult = { ok: true; data: SiweMessage } | { ok: false; reason: string }

/**
 * Verify a SIWE message + signature. Checks signature validity and the
 * expected domain/nonce. Uses viem's verifySiweMessage which supports
 * EIP-6492 (deployed-via-counterfactual smart wallets) where possible.
 */
export async function verifyAndParseSiwe(
  rawMessage: string,
  signature: Hex,
  expectedNonce: string,
  expectedDomain: string,
): Promise<SiweVerifyResult> {
  let parsed: SiweMessage
  try {
    parsed = parseSiweMessage(rawMessage) as SiweMessage
  } catch (err) {
    return { ok: false, reason: `parse: ${(err as Error).message}` }
  }
  if (parsed.nonce !== expectedNonce) {
    return { ok: false, reason: 'nonce mismatch' }
  }
  if (parsed.domain !== expectedDomain) {
    return { ok: false, reason: `domain mismatch: ${parsed.domain} vs ${expectedDomain}` }
  }
  try {
    const valid = await verifySiweMessage(publicClient, {
      message: rawMessage,
      signature,
    })
    if (!valid) {
      return { ok: false, reason: 'signature invalid' }
    }
  } catch (err) {
    return { ok: false, reason: `verify: ${(err as Error).message}` }
  }
  return { ok: true, data: parsed }
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
