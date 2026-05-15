import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import { ANIMA_WC_PROJECT_ID, WalletConnectOperatorSigner } from './walletconnect'

describe('WalletConnectOperatorSigner', () => {
  test('exports the anima project id as a 32-char hex', () => {
    expect(ANIMA_WC_PROJECT_ID).toMatch(/^[a-f0-9]{32}$/)
  })

  test('constructor sets source label to walletconnect', () => {
    const s = new WalletConnectOperatorSigner()
    expect(s.source).toBe('walletconnect')
  })

  test('chain() returns the requested 0G chain', () => {
    const s = new WalletConnectOperatorSigner()
    expect(s.chain('0g-mainnet').id).toBe(16661)
    expect(s.chain('0g-testnet').id).toBe(16602)
  })

  /**
   * Regression test for the -32004 bug: viem's sendTransaction picks the path
   * based on `account.type`. With type='local' it calls `eth_signTransaction`
   * first (MM Mobile rejects with -32004) then `eth_sendRawTransaction`. With
   * type='json-rpc' it calls `eth_sendTransaction` directly (one MM popup,
   * MM signs + broadcasts). The walletClient produced by this signer MUST be
   * a json-rpc account or the WC operator can never mint on chains that need
   * `eth_sendTransaction` to reach the wallet (effectively all of them).
   */
  test('walletClient() uses a json-rpc account so viem hits eth_sendTransaction', async () => {
    const s = new WalletConnectOperatorSigner()
    const fakeAddr: Address = '0x06b74fe8070c96d92e3a2a8a871849ac81e4c09e'
    const seenMethods: string[] = []
    const fakeProvider = {
      session: { topic: 'fake' },
      accounts: [fakeAddr],
      async request({ method }: { method: string; params?: unknown[] }) {
        seenMethods.push(method)
        if (method === 'eth_chainId') return '0x4115' // 16661
        if (method === 'eth_blockNumber') return '0x1'
        if (method === 'wallet_addEthereumChain') return null
        if (method === 'wallet_switchEthereumChain') return null
        if (method === 'eth_sendTransaction') return '0xdeadbeef'
        if (method === 'eth_signTransaction') {
          throw new Error('eth_signTransaction must NOT be invoked under the json-rpc fix')
        }
        return null
      },
    }
    // Inject the fake into the private slots ensureProvider would populate.
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private state
    const slf = s as any
    slf.provider = fakeProvider
    slf.connectedAddress = fakeAddr

    const wc = await s.walletClient('0g-mainnet')
    expect(wc.account?.type).toBe('json-rpc')

    // Drive a real sendTransaction through the wallet client; the fake
    // provider will record which method viem ends up calling.
    const hash = await wc.sendTransaction({
      account: wc.account ?? null,
      to: '0x0000000000000000000000000000000000000001',
      value: 1n,
      chain: s.chain('0g-mainnet'),
    })
    expect(hash).toBe('0xdeadbeef')
    expect(seenMethods).toContain('eth_sendTransaction')
    expect(seenMethods).not.toContain('eth_signTransaction')
  })

  /**
   * Regression test for the EIP712Domain trap (v0.24.9). The legacy WC signer
   * shipped `eth_signTypedData_v4` payloads verbatim without `EIP712Domain`
   * in `types`, so MetaMask's `sanitizeData` inserted `EIP712Domain: []`
   * (empty), producing a different domain separator than viem's canonical
   * hash. New WC keystores encrypted via that path could not be decrypted by
   * any LocalAccount signer (raw-privkey, keystore-file, keychain) or the
   * /console wagmi flow. After the v0.24.9 fix, the signer MUST inject the
   * canonical EIP712Domain field set before serializing.
   */
  test('signTypedData injects canonical EIP712Domain before eth_signTypedData_v4', async () => {
    const s = new WalletConnectOperatorSigner()
    const fakeAddr: Address = '0x06b74fe8070c96d92e3a2a8a871849ac81e4c09e'
    const capturedPayloads: string[] = []
    const fakeProvider = {
      session: { topic: 'fake' },
      accounts: [fakeAddr],
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === 'eth_signTypedData_v4') {
          capturedPayloads.push((params as [string, string])[1])
          return '0xaa'.padEnd(132, '0') as `0x${string}`
        }
        return null
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private state
    const slf = s as any
    slf.provider = fakeProvider
    slf.connectedAddress = fakeAddr

    const account = await s.account()
    await account.signTypedData({
      domain: { name: 'Anima Keystore', version: '1' },
      types: {
        AgentKeystore: [
          { name: 'agent', type: 'address' },
          { name: 'purpose', type: 'string' },
        ],
      },
      primaryType: 'AgentKeystore',
      message: { agent: fakeAddr, purpose: 'anima-keystore-v1' },
    })
    expect(capturedPayloads.length).toBe(1)
    const sent = JSON.parse(capturedPayloads[0]!)
    expect(sent.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
    ])
    // primaryType + message preserved
    expect(sent.primaryType).toBe('AgentKeystore')
    expect(sent.message.purpose).toBe('anima-keystore-v1')
  })

  test('signTypedData omits absent domain fields from EIP712Domain (only name+version when those are all that is set)', async () => {
    const s = new WalletConnectOperatorSigner()
    const fakeAddr: Address = '0x06b74fe8070c96d92e3a2a8a871849ac81e4c09e'
    const capturedPayloads: string[] = []
    const fakeProvider = {
      session: { topic: 'fake' },
      accounts: [fakeAddr],
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === 'eth_signTypedData_v4') {
          capturedPayloads.push((params as [string, string])[1])
          return '0xaa'.padEnd(132, '0') as `0x${string}`
        }
        return null
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private state
    const slf = s as any
    slf.provider = fakeProvider
    slf.connectedAddress = fakeAddr

    const account = await s.account()
    await account.signTypedData({
      domain: {
        name: 'Anima',
        version: '1',
        chainId: 16661,
        verifyingContract: '0x0000000000000000000000000000000000000001',
      },
      types: { X: [{ name: 'a', type: 'string' }] },
      primaryType: 'X',
      message: { a: 'b' },
    })
    const sent = JSON.parse(capturedPayloads[0]!)
    expect(sent.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ])
  })

  test('signTypedDataLegacyEmptyDomain escape hatch ships verbatim (no EIP712Domain injection)', async () => {
    const s = new WalletConnectOperatorSigner()
    const fakeAddr: Address = '0x06b74fe8070c96d92e3a2a8a871849ac81e4c09e'
    const capturedPayloads: string[] = []
    const fakeProvider = {
      session: { topic: 'fake' },
      accounts: [fakeAddr],
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === 'eth_signTypedData_v4') {
          capturedPayloads.push((params as [string, string])[1])
          return '0xbb'.padEnd(132, '0') as `0x${string}`
        }
        return null
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to private state
    const slf = s as any
    slf.provider = fakeProvider
    slf.connectedAddress = fakeAddr

    const account = await s.account()
    // biome-ignore lint/suspicious/noExplicitAny: testing the non-typed escape-hatch method
    const legacy = (account as any).signTypedDataLegacyEmptyDomain
    expect(typeof legacy).toBe('function')
    await legacy({
      domain: { name: 'Anima Keystore', version: '1' },
      types: {
        AgentKeystore: [
          { name: 'agent', type: 'address' },
          { name: 'purpose', type: 'string' },
        ],
      },
      primaryType: 'AgentKeystore',
      message: { agent: fakeAddr, purpose: 'anima-keystore-v1' },
    })
    expect(capturedPayloads.length).toBe(1)
    const sent = JSON.parse(capturedPayloads[0]!)
    // Verbatim: types has AgentKeystore but NO EIP712Domain. This is the
    // exact byte pattern that triggered MM's empty-EIP712Domain insertion
    // on legacy v0.8-v0.24.8 WC keystores.
    expect(sent.types.AgentKeystore).toBeDefined()
    expect(sent.types.EIP712Domain).toBeUndefined()
  })
})
