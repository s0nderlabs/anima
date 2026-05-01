import { describe, expect, test } from 'bun:test'
import {
  SANDBOX_NIP_IO_HOST,
  SANDBOX_PROVIDER_GALILEO,
  SANDBOX_PROVIDER_URL_GALILEO,
  SANDBOX_TEE_SIGNER_GALILEO,
  buildSandboxEndpoint,
} from './index'

describe('og-sandbox constants + endpoint helper', () => {
  test('Galileo provider constants pinned', () => {
    expect(SANDBOX_NIP_IO_HOST).toBe('43.106.147.28.nip.io:4000')
    expect(SANDBOX_PROVIDER_GALILEO).toBe('0xB831371eb2703305f1d9F8542163633D0675CEd7')
    expect(SANDBOX_TEE_SIGNER_GALILEO).toBe('0x2567a8b81305e1D9070B551314f7354185a412e3')
    expect(SANDBOX_PROVIDER_URL_GALILEO).toBe('https://provider-private-sandbox-testnet.0g.ai')
  })

  test('buildSandboxEndpoint default port 8080', () => {
    const url = buildSandboxEndpoint({ sandboxId: 'abc-123' })
    expect(url).toBe('http://8080-abc-123.43.106.147.28.nip.io:4000')
  })

  test('buildSandboxEndpoint honors custom port', () => {
    const url = buildSandboxEndpoint({ sandboxId: 'abc-123', port: 9090 })
    expect(url).toBe('http://9090-abc-123.43.106.147.28.nip.io:4000')
  })
})
