import { describe, expect, test } from 'bun:test'
import { recoverMessageAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { signRequest } from './auth'

describe('signRequest', () => {
  test('produces three EIP-191 headers that recoverable to operator', async () => {
    const operatorPriv = generatePrivateKey()
    const operator = privateKeyToAccount(operatorPriv)
    const headers = await signRequest({
      operator,
      action: 'create',
      payload: { image: 'ubuntu:22.04', sealed: false },
    })
    expect(headers['X-Wallet-Address']).toBe(operator.address)
    expect(headers['X-Signed-Message']).toBeTruthy()
    expect(headers['X-Wallet-Signature']).toMatch(/^0x[0-9a-f]{130}$/i)

    // Recover and verify
    const json = Buffer.from(headers['X-Signed-Message'], 'base64').toString('utf8')
    const recovered = await recoverMessageAddress({
      message: json,
      signature: headers['X-Wallet-Signature'],
    })
    expect(recovered).toBe(operator.address)
  })

  test('respects override expiresAt + nonce', async () => {
    const operatorPriv = generatePrivateKey()
    const operator = privateKeyToAccount(operatorPriv)
    const headers = await signRequest({
      operator,
      action: 'list',
      expiresAtSec: 1_700_000_000,
      nonce: 'deadbeef'.repeat(4),
    })
    const json = Buffer.from(headers['X-Signed-Message'], 'base64').toString('utf8')
    const parsed = JSON.parse(json) as { action: string; expires_at: number; nonce: string }
    expect(parsed.action).toBe('list')
    expect(parsed.expires_at).toBe(1_700_000_000)
    expect(parsed.nonce).toBe('deadbeef'.repeat(4))
  })

  test('uses canonical key order in serialized JSON (action, expires_at, nonce, payload, resource_id)', async () => {
    const operator = privateKeyToAccount(generatePrivateKey())
    const headers = await signRequest({
      operator,
      action: 'delete',
      resourceId: 'sbx-123',
      payload: { foo: 'bar' },
    })
    const json = Buffer.from(headers['X-Signed-Message'], 'base64').toString('utf8')
    const expectedKeys = ['action', 'expires_at', 'nonce', 'payload', 'resource_id']
    const positions = expectedKeys.map(k => json.indexOf(`"${k}"`))
    expect(positions.every(p => p >= 0)).toBe(true)
    const sorted = [...positions].sort((a, b) => a - b)
    expect(positions).toEqual(sorted)
  })
})
