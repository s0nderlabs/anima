// EIP-712 typed-data matching packages/core/src/wallet/operator-keystore-crypto.ts:33-41.
// Operator signs this once per agent to derive the keystore-decryption AES key.

import type { Address } from 'viem'

export const KEYSTORE_DOMAIN = {
  name: 'Anima Keystore',
  version: '1',
} as const

export const KEYSTORE_TYPES = {
  AgentKeystore: [
    { name: 'agent', type: 'address' },
    { name: 'purpose', type: 'string' },
  ],
} as const

export const KEYSTORE_PURPOSE = 'anima-keystore-v1'

export function keystoreTypedData(agentAddress: Address) {
  return {
    domain: KEYSTORE_DOMAIN,
    types: KEYSTORE_TYPES,
    primaryType: 'AgentKeystore' as const,
    message: {
      agent: agentAddress,
      purpose: KEYSTORE_PURPOSE,
    },
  }
}
