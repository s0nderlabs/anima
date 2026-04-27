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
})
