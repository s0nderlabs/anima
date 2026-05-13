// Trimmed ABIs for read-only console use.
// Sourced from packages/core/src/identity/abi.ts + packages/core/src/naming/sann.ts.

export const AGENT_NFT_ABI = [
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getIntelligentData',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          { name: 'dataDescription', type: 'string' },
          { name: 'dataHash', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getSlotHash',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'slot', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'event',
    name: 'Minted',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      {
        name: 'iDatas',
        type: 'tuple[]',
        indexed: false,
        components: [
          { name: 'dataDescription', type: 'string' },
          { name: 'dataHash', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'Transferred',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Updated',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'slots', type: 'uint256[]', indexed: false },
      { name: 'newHashes', type: 'bytes32[]', indexed: false },
    ],
  },
] as const

export const SANN_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const

export const SANN_RESOLVER_ABI = [
  {
    type: 'function',
    name: 'text',
    stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
    ],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const

// 0G Compute LedgerManager (mainnet 0x2dE54c84..., testnet 0xE7083050...).
// Mirrors packages/core/src/brain/ledger.ts LEDGER_READ_ABI.
export const LEDGER_MANAGER_ABI = [
  {
    type: 'function',
    name: 'getLedger',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'user', type: 'address' },
          { name: 'availableBalance', type: 'uint256' },
          { name: 'totalBalance', type: 'uint256' },
          { name: 'additionalInfo', type: 'string' },
        ],
      },
    ],
  },
] as const

export const LEDGER_MANAGER_MAINNET = '0x2dE54c845Cd948B72D2e32e39586fe89607074E3' as const
export const LEDGER_MANAGER_TESTNET = '0xE70830508dAc0A97e6c087c75f402f9Be669E406' as const

// 0G Sandbox SandboxServing settlement (Galileo testnet only).
// Mirrors packages/core/src/og-sandbox/abi.ts.
export const SANDBOX_SERVING_ABI = [
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'provider', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

export const SANDBOX_SETTLEMENT_GALILEO = '0xd7e0CD227e602FedBb93c36B1F5bf415398508a4' as const
export const SANDBOX_PROVIDER_GALILEO = '0xB831371eb2703305f1d9F8542163633D0675CEd7' as const
