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
