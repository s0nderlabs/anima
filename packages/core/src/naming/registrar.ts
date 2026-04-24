import type { Address, Chain, Hex, PublicClient, WalletClient } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { MIN_GAS_PRICE, makeViemClients } from '../chain'
import { waitForReceiptResilient } from '../identity/receipt'
import { readRegistryOwner, subnameNode } from './sann'

/**
 * Permissionless `.anima.0g` subname registrar deployed via CREATE2 on
 * mainnet. Any EOA with gas can register a label via `claim(label, owner)`.
 * See contracts/src/AnimaSubnameRegistrar.sol.
 */
export const ANIMA_REGISTRAR_ADDRESS: Address = '0x33d9f4ec2bd7e7cb4e288c3bbc3a76be472fdd98'

const REGISTRAR_ABI = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'owner_', type: 'address' },
    ],
    outputs: [{ name: 'subnameNode', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'isOperational',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'ANIMA_NODE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'event',
    name: 'SubnameClaimed',
    inputs: [
      { name: 'label', type: 'string', indexed: false },
      { name: 'subnameNode', type: 'bytes32', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'claimer', type: 'address', indexed: true },
    ],
  },
] as const

export interface AnimaRegistrarClientOpts {
  privkeyHex: Hex
  /** Override the default registrar address (for tests / future redeploys). */
  registrar?: Address
}

export class AnimaRegistrarClient {
  readonly publicClient: PublicClient
  readonly walletClient: WalletClient
  readonly account: PrivateKeyAccount
  readonly registrar: Address
  private readonly chain: Chain

  constructor(opts: AnimaRegistrarClientOpts) {
    const clients = makeViemClients({ network: '0g-mainnet', privkeyHex: opts.privkeyHex })
    this.account = clients.account
    this.chain = clients.chain
    this.publicClient = clients.publicClient
    this.walletClient = clients.walletClient
    this.registrar = opts.registrar ?? ANIMA_REGISTRAR_ADDRESS
  }

  /**
   * Register `<label>.anima.0g` owned by `owner`. Reverts if label is taken.
   * Returns the transaction hash. The caller pays gas; ownership goes to `owner`.
   */
  async claim(label: string, owner: Address): Promise<Hex> {
    return await this.walletClient.writeContract({
      address: this.registrar,
      abi: REGISTRAR_ABI,
      functionName: 'claim',
      args: [label, owner],
      chain: this.chain,
      account: this.account,
      maxFeePerGas: MIN_GAS_PRICE,
      maxPriorityFeePerGas: MIN_GAS_PRICE,
    })
  }

  async waitForReceipt(hash: Hex): Promise<void> {
    const r = await waitForReceiptResilient(this.publicClient, hash)
    if (r.status !== 'success') throw new Error(`claim tx reverted: ${hash}`)
  }

  async isOperational(): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.registrar,
      abi: REGISTRAR_ABI,
      functionName: 'isOperational',
    })) as boolean
  }

  /** UX fail-fast: checks the SANN registry so we don't pay gas for a doomed claim. */
  async isLabelTaken(label: string): Promise<boolean> {
    const o = await readRegistryOwner(this.publicClient, subnameNode(label))
    return o !== '0x0000000000000000000000000000000000000000'
  }
}
