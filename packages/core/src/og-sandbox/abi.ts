/**
 * Minimal ABI fragments for the 0G Sandbox SandboxServing settlement contract.
 *
 * Source: github.com/0gfoundation/0g-sandbox @ contracts/src/SandboxServing.sol
 * Galileo testnet proxy: 0xd7e0CD227e602FedBb93c36B1F5bf415398508a4
 */
export const SANDBOX_SERVING_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'provider', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'requestRefund',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawRefund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'provider', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'acknowledgeTEESigner',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'acknowledged', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'provider', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isTEEAcknowledged',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'provider', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getLastNonce',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'provider', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'provider', type: 'address', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TEESignerAcknowledged',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'provider', type: 'address', indexed: true },
      { name: 'acknowledged', type: 'bool', indexed: false },
    ],
  },
] as const

/**
 * Galileo testnet (chain 16602) sandbox settlement contract.
 * Proxy address; backed by an UpgradeableBeacon, may upgrade implementation.
 */
export const SANDBOX_SETTLEMENT_GALILEO = '0xd7e0CD227e602FedBb93c36B1F5bf415398508a4' as const
