import type { Address, Hex, PublicClient, WalletClient } from 'viem'
import { SANDBOX_SERVING_ABI, SANDBOX_SETTLEMENT_GALILEO } from './abi'

export interface SettlementClientOpts {
  publicClient: PublicClient
  walletClient?: WalletClient
  /** SandboxServing proxy address. Defaults to Galileo. */
  contractAddress?: Address
}

/**
 * Thin wrapper around the SandboxServing settlement contract for our
 * deploy/upgrade/refund flows. Read-only functions need only `publicClient`;
 * write functions require `walletClient`.
 *
 * On-chain pricing carried by the provider's signed broker; this contract
 * only tracks user balance + TEE acknowledgement state.
 */
export class SandboxSettlementClient {
  publicClient: PublicClient
  walletClient: WalletClient | undefined
  contractAddress: Address

  constructor(opts: SettlementClientOpts) {
    this.publicClient = opts.publicClient
    this.walletClient = opts.walletClient
    this.contractAddress = opts.contractAddress ?? SANDBOX_SETTLEMENT_GALILEO
  }

  async getBalance(user: Address, provider: Address): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: SANDBOX_SERVING_ABI,
      functionName: 'getBalance',
      args: [user, provider],
    })) as bigint
  }

  async isTEEAcknowledged(user: Address, provider: Address): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: SANDBOX_SERVING_ABI,
      functionName: 'isTEEAcknowledged',
      args: [user, provider],
    })) as boolean
  }

  async deposit(opts: { recipient: Address; provider: Address; amountWei: bigint }): Promise<Hex> {
    if (!this.walletClient) throw new Error('walletClient-required')
    const account = this.walletClient.account
    if (!account) throw new Error('walletClient-account-required')
    const chain = this.walletClient.chain
    if (!chain) throw new Error('walletClient-chain-required')
    return this.walletClient.writeContract({
      account,
      chain,
      address: this.contractAddress,
      abi: SANDBOX_SERVING_ABI,
      functionName: 'deposit',
      args: [opts.recipient, opts.provider],
      value: opts.amountWei,
    })
  }

  async acknowledgeTEESigner(opts: { provider: Address; acknowledged: boolean }): Promise<Hex> {
    if (!this.walletClient) throw new Error('walletClient-required')
    const account = this.walletClient.account
    if (!account) throw new Error('walletClient-account-required')
    const chain = this.walletClient.chain
    if (!chain) throw new Error('walletClient-chain-required')
    return this.walletClient.writeContract({
      account,
      chain,
      address: this.contractAddress,
      abi: SANDBOX_SERVING_ABI,
      functionName: 'acknowledgeTEESigner',
      args: [opts.provider, opts.acknowledged],
    })
  }

  async requestRefund(opts: { provider: Address; amountWei: bigint }): Promise<Hex> {
    if (!this.walletClient) throw new Error('walletClient-required')
    const account = this.walletClient.account
    if (!account) throw new Error('walletClient-account-required')
    const chain = this.walletClient.chain
    if (!chain) throw new Error('walletClient-chain-required')
    return this.walletClient.writeContract({
      account,
      chain,
      address: this.contractAddress,
      abi: SANDBOX_SERVING_ABI,
      functionName: 'requestRefund',
      args: [opts.provider, opts.amountWei],
    })
  }

  async withdrawRefund(opts: { provider: Address }): Promise<Hex> {
    if (!this.walletClient) throw new Error('walletClient-required')
    const account = this.walletClient.account
    if (!account) throw new Error('walletClient-account-required')
    const chain = this.walletClient.chain
    if (!chain) throw new Error('walletClient-chain-required')
    return this.walletClient.writeContract({
      account,
      chain,
      address: this.contractAddress,
      abi: SANDBOX_SERVING_ABI,
      functionName: 'withdrawRefund',
      args: [opts.provider],
    })
  }
}
