import { describe, expect, test } from 'bun:test'
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
})
