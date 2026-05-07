import {
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
} from 'viem'
import { NETWORK_RPC } from '../config'
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

// Galileo provider wallet that recipients deposit against. Inlined here to
// avoid a circular import with index.ts (which re-exports settlement.ts).
const SANDBOX_PROVIDER_GALILEO_INTERNAL =
  '0xB831371eb2703305f1d9F8542163633D0675CEd7' as const satisfies Address

/**
 * Read the SandboxSettlement billing reserve for `recipient` against `provider`,
 * without needing a pre-built PublicClient. Self-contained: spins its own viem
 * client against the Galileo testnet RPC. Returns 0n if the chain reverts (e.g.
 * recipient never deposited for that provider).
 *
 * Used by `anima balance` (CLI) and `account.balance` (brain tool) to surface
 * the operator-funded sandbox runtime reserve in one read. The recipient is
 * the OPERATOR wallet that signed `anima topup --sandbox`, not the agent EOA.
 */
export async function getSandboxBillingReserve(opts: {
  recipient: Address
  provider?: Address
  rpcUrl?: string
}): Promise<bigint> {
  const provider = opts.provider ?? SANDBOX_PROVIDER_GALILEO_INTERNAL
  const rpcUrl = opts.rpcUrl ?? NETWORK_RPC['0g-testnet']
  const client = createPublicClient({ transport: http(rpcUrl) })
  try {
    return (await client.readContract({
      address: SANDBOX_SETTLEMENT_GALILEO,
      abi: SANDBOX_SERVING_ABI,
      functionName: 'getBalance',
      args: [opts.recipient, provider],
    })) as bigint
  } catch {
    return 0n
  }
}
