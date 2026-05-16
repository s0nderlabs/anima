import {
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  getAddress,
  keccak256,
  pad,
  stringToBytes,
  toHex,
} from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { MIN_GAS_PRICE, makeViemClients } from '../chain'
import { waitForReceiptResilient } from '../identity/receipt'

/**
 * SPACE ID on 0G mainnet uses the SANN architecture. Contracts discovered via
 * `RegistrarController.sann()` + `SANN.registry()` + `SANN.tldBase(IDENTIFIER)`.
 */
export const SANN_SUFFIX = '.anima.0g' as const

export const SANN_ADDRESSES = {
  controller: '0xD7b837A0E388B4c25200983bdAa3EF3A83ca86b7' as Address,
  resolver: '0x6D3B3F99177FB2A5de7F9E928a9BD807bF7b5BAD' as Address,
  sann: '0x9af6F1244df403dAe39Eb2D0be1C3fD0B38e0789' as Address,
  registry: '0x5dC881dDA4e4a8d312be3544AD13118D1a04Cb17' as Address,
  tldBase0G: '0x75f7590Def0905566805298F021A7174715eF0cd' as Address,
  tldIdentifier: 449205675366457712613706471770511817162982777845754732038879201565074548n,
}

const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'setResolver',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setSubnodeOwner',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'label', type: 'bytes32' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
] as const

const RESOLVER_ABI = [
  {
    type: 'function',
    name: 'setText',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
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
] as const

/** SANN-style namehash. Note: NOT the same as ENS namehash. */
export function sannNamehash(tldIdentifier: bigint, tld: string, sub: string[]): Hex {
  const idBytes = pad(toHex(tldIdentifier), { size: 32 })
  const zero: Hex = `0x${'00'.repeat(32)}`
  const identifierNode = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [zero, idBytes]),
  )
  const tldHash = keccak256(stringToBytes(tld))
  let node = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [identifierNode, tldHash]),
  )
  for (const label of sub) {
    const labelHash = keccak256(stringToBytes(label))
    node = keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [node, labelHash]),
    )
  }
  return node
}

/** Compute the SANN node for `<label>.anima.0g`. */
export function subnameNode(label: string): Hex {
  return sannNamehash(SANN_ADDRESSES.tldIdentifier, '0g', ['anima', label])
}

/** Read the registry owner of any SANN node. Shared by SannClient + AnimaRegistrarClient. */
export async function readRegistryOwner(client: PublicClient, node: Hex): Promise<Address> {
  return (await client.readContract({
    address: SANN_ADDRESSES.registry,
    abi: REGISTRY_ABI,
    functionName: 'owner',
    args: [node],
  })) as Address
}

/**
 * Resolve a `<label>.anima.0g` subname to the address text record published
 * by the agent at init time. Returns null when the record is empty / invalid;
 * throws on RPC failure. Shared by chain.send + agent.message + any future
 * tool that accepts a SANN name where an address is expected.
 */
export async function resolveSubnameAddress(
  client: PublicClient,
  label: string,
): Promise<Address | null> {
  if (!label) return null
  const node = subnameNode(label)
  const raw = (await client.readContract({
    address: SANN_ADDRESSES.resolver,
    abi: RESOLVER_ABI,
    functionName: 'text',
    args: [node, 'address'],
  })) as string
  if (!raw) return null
  try {
    return getAddress(raw)
  } catch {
    return null
  }
}

export interface SannClientOpts {
  privkeyHex: Hex
}

export class SannClient {
  readonly publicClient: PublicClient
  readonly walletClient: WalletClient
  readonly account: PrivateKeyAccount
  private readonly chain: Chain
  private readonly animaNode: Hex

  constructor(opts: SannClientOpts) {
    const clients = makeViemClients({ network: '0g-mainnet', privkeyHex: opts.privkeyHex })
    this.account = clients.account
    this.chain = clients.chain
    this.publicClient = clients.publicClient
    this.walletClient = clients.walletClient
    this.animaNode = sannNamehash(SANN_ADDRESSES.tldIdentifier, '0g', ['anima'])
  }

  /**
   * Issue `<label>.anima.0g` to `owner`. Caller must be the registry owner
   * of `anima.0g`. Calls `SidRegistry.setSubnodeOwner(animaNode, labelHash, owner)`
   * directly — `Base.reclaim` resets parent ownership after NFT transfer, NOT
   * for creating children.
   */
  async reclaimSubname(label: string, owner: Address): Promise<Hex> {
    const labelHash = keccak256(stringToBytes(label))
    return await this.walletClient.writeContract({
      address: SANN_ADDRESSES.registry,
      abi: REGISTRY_ABI,
      functionName: 'setSubnodeOwner',
      args: [this.animaNode, labelHash, owner],
      chain: this.chain,
      account: this.account,
      maxFeePerGas: MIN_GAS_PRICE,
      maxPriorityFeePerGas: MIN_GAS_PRICE,
    })
  }

  /** Set the resolver for a subname node. Caller must be the subname owner. */
  async setSubnameResolver(node: Hex): Promise<Hex> {
    return await this.walletClient.writeContract({
      address: SANN_ADDRESSES.registry,
      abi: REGISTRY_ABI,
      functionName: 'setResolver',
      args: [node, SANN_ADDRESSES.resolver],
      chain: this.chain,
      account: this.account,
      maxFeePerGas: MIN_GAS_PRICE,
      maxPriorityFeePerGas: MIN_GAS_PRICE,
    })
  }

  /** Write a single text record. Caller must be the subname owner. */
  async setText(node: Hex, key: string, value: string): Promise<Hex> {
    return await this.walletClient.writeContract({
      address: SANN_ADDRESSES.resolver,
      abi: RESOLVER_ABI,
      functionName: 'setText',
      args: [node, key, value],
      chain: this.chain,
      account: this.account,
      maxFeePerGas: MIN_GAS_PRICE,
      maxPriorityFeePerGas: MIN_GAS_PRICE,
    })
  }

  async readText(node: Hex, key: string): Promise<string> {
    return (await this.publicClient.readContract({
      address: SANN_ADDRESSES.resolver,
      abi: RESOLVER_ABI,
      functionName: 'text',
      args: [node, key],
    })) as string
  }

  async registryOwnerOf(node: Hex): Promise<Address> {
    return await readRegistryOwner(this.publicClient, node)
  }

  async waitForReceipt(hash: Hex): Promise<void> {
    const r = await waitForReceiptResilient(this.publicClient, hash)
    if (r.status !== 'success') throw new Error(`tx reverted: ${hash}`)
  }
}
