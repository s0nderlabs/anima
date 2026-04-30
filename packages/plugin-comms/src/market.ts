import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
  parseAbi,
} from 'viem'

/**
 * AnimaMarket ABI. Mirrors `contracts/src/AnimaMarket.sol`.
 */
export const ANIMA_MARKET_ABI = parseAbi([
  // events
  'event JobCreated(uint256 indexed jobId, address indexed buyer, address indexed provider, uint256 amount, bytes32 descriptionHash)',
  'event JobMarkedDone(uint256 indexed jobId, uint256 doneAt)',
  'event JobAccepted(uint256 indexed jobId)',
  'event JobDisputed(uint256 indexed jobId)',
  'event JobSettled(uint256 indexed jobId, address indexed recipient, uint256 payout, uint256 fee)',
  'event SplitProposed(uint256 indexed jobId, address indexed proposer, uint256 buyerAmount, uint256 providerAmount)',
  'event SplitResolved(uint256 indexed jobId, uint256 buyerPayout, uint256 providerPayout, uint256 fee)',
  'event JobForceClosed(uint256 indexed jobId)',
  // mutating
  'function createJob(address provider, bytes32 descriptionHash) payable returns (uint256 jobId)',
  'function markDone(uint256 jobId)',
  'function acceptResult(uint256 jobId)',
  'function dispute(uint256 jobId)',
  'function claimTimeout(uint256 jobId)',
  'function proposeSplit(uint256 jobId, uint256 buyerAmount, uint256 providerAmount)',
  'function forceClose(uint256 jobId)',
  // views
  'function jobCount() view returns (uint256)',
  'function feeRecipient() view returns (address)',
  'function getJob(uint256 jobId) view returns ((address buyer, address provider, uint256 amount, bytes32 descriptionHash, uint8 status, uint256 createdAt, uint256 doneAt))',
  'function splitProposals(uint256 jobId, address party) view returns (bytes32)',
  // constants
  'function PROTOCOL_FEE_BPS() view returns (uint256)',
  'function ACCEPTANCE_PERIOD() view returns (uint256)',
  'function MAX_JOB_LIFETIME() view returns (uint256)',
  'function MIN_JOB_AMOUNT() view returns (uint256)',
  // errors
  'error ZeroAddress()',
  'error SelfTrade()',
  'error AmountBelowMinimum()',
  'error JobNotFound(uint256 jobId)',
  'error InvalidStatus(uint256 jobId, uint8 expected, uint8 actual)',
  'error NotBuyer()',
  'error NotProvider()',
  'error NotParty()',
  'error AcceptancePeriodNotExpired(uint256 jobId)',
  'error AcceptancePeriodExpired(uint256 jobId)',
  'error MaxLifetimeNotExpired(uint256 jobId)',
  'error AlreadySettled(uint256 jobId)',
  'error InvalidSplitAmounts(uint256 total, uint256 expected)',
  'error NativeTransferFailed(address to, uint256 amount)',
])

export const JOB_STATUS = {
  Funded: 0,
  Done: 1,
  Disputed: 2,
  Settled: 3,
} as const

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS]

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  0: 'funded',
  1: 'done',
  2: 'disputed',
  3: 'settled',
}

export interface Job {
  buyer: Address
  provider: Address
  amount: bigint
  descriptionHash: Hex
  status: JobStatus
  createdAt: bigint
  doneAt: bigint
}

export interface JobCreatedEvent {
  jobId: bigint
  buyer: Address
  provider: Address
  amount: bigint
  descriptionHash: Hex
  blockNumber: bigint
  txHash: Hex
}

export interface JobLifecycleEvent {
  jobId: bigint
  kind:
    | 'markedDone'
    | 'accepted'
    | 'disputed'
    | 'settled'
    | 'splitProposed'
    | 'splitResolved'
    | 'forceClosed'
  blockNumber: bigint
  txHash: Hex
  /** Field set per kind; varies. */
  meta: Record<string, unknown>
}

export interface MarketClientOpts {
  address: Address
  publicClient: PublicClient
  walletClient?: WalletClient
}

/**
 * Read + write client for AnimaMarket. Mirrors AnimaInboxClient pattern:
 * the agent's local harness signs every tx with its own EOA. No EIP-712,
 * no relayer, no off-chain meta-tx ceremony.
 */
export class AnimaMarketClient {
  readonly address: Address
  private readonly publicClient: PublicClient
  private readonly walletClient: WalletClient | null

  constructor(opts: MarketClientOpts) {
    this.address = opts.address
    this.publicClient = opts.publicClient
    this.walletClient = opts.walletClient ?? null
  }

  // ── writes ──

  async createJob(provider: Address, amount: bigint, descriptionHash: Hex): Promise<Hex> {
    const wc = this._writeClient()
    const data = encodeFunctionData({
      abi: ANIMA_MARKET_ABI,
      functionName: 'createJob',
      args: [provider, descriptionHash],
    })
    return wc.sendTransaction({
      account: wc.account!,
      chain: wc.chain,
      to: this.address,
      data,
      value: amount,
    })
  }

  async markDone(jobId: bigint): Promise<Hex> {
    return this._send('markDone', [jobId])
  }

  async acceptResult(jobId: bigint): Promise<Hex> {
    return this._send('acceptResult', [jobId])
  }

  async dispute(jobId: bigint): Promise<Hex> {
    return this._send('dispute', [jobId])
  }

  async claimTimeout(jobId: bigint): Promise<Hex> {
    return this._send('claimTimeout', [jobId])
  }

  async proposeSplit(jobId: bigint, buyerAmount: bigint, providerAmount: bigint): Promise<Hex> {
    return this._send('proposeSplit', [jobId, buyerAmount, providerAmount])
  }

  async forceClose(jobId: bigint): Promise<Hex> {
    return this._send('forceClose', [jobId])
  }

  // ── reads ──

  async getJob(jobId: bigint): Promise<Job> {
    const r = (await this.publicClient.readContract({
      address: this.address,
      abi: ANIMA_MARKET_ABI,
      functionName: 'getJob',
      args: [jobId],
    })) as {
      buyer: Address
      provider: Address
      amount: bigint
      descriptionHash: Hex
      status: number
      createdAt: bigint
      doneAt: bigint
    }
    return {
      buyer: r.buyer,
      provider: r.provider,
      amount: r.amount,
      descriptionHash: r.descriptionHash,
      status: r.status as JobStatus,
      createdAt: r.createdAt,
      doneAt: r.doneAt,
    }
  }

  async jobCount(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ANIMA_MARKET_ABI,
      functionName: 'jobCount',
    })) as bigint
  }

  async splitProposalOf(jobId: bigint, party: Address): Promise<Hex> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ANIMA_MARKET_ABI,
      functionName: 'splitProposals',
      args: [jobId, party],
    })) as Hex
  }

  // ── events catch-up ──

  /**
   * Catch up JobCreated events where the agent is buyer OR provider.
   * Two RPC calls (filter on indexed buyer, then filter on indexed provider).
   */
  async getJobsCreatedBy(
    agent: Address,
    fromBlock: bigint,
    toBlock: bigint | 'latest' = 'latest',
  ): Promise<JobCreatedEvent[]> {
    const evt = {
      type: 'event' as const,
      name: 'JobCreated',
      inputs: [
        { name: 'jobId', type: 'uint256', indexed: true },
        { name: 'buyer', type: 'address', indexed: true },
        { name: 'provider', type: 'address', indexed: true },
        { name: 'amount', type: 'uint256' },
        { name: 'descriptionHash', type: 'bytes32' },
      ],
    } as const
    const [asBuyer, asProvider] = await Promise.all([
      this.publicClient.getLogs({
        address: this.address,
        event: evt,
        args: { buyer: agent },
        fromBlock,
        toBlock,
      }),
      this.publicClient.getLogs({
        address: this.address,
        event: evt,
        args: { provider: agent },
        fromBlock,
        toBlock,
      }),
    ])
    const all = [...asBuyer, ...asProvider]
    const seen = new Set<string>()
    const out: JobCreatedEvent[] = []
    for (const l of all) {
      const k = `${l.transactionHash}:${l.logIndex}`
      if (seen.has(k)) continue
      seen.add(k)
      // viem types args as the named fields directly; narrow via cast.
      const args = l.args as {
        jobId: bigint
        buyer: Address
        provider: Address
        amount: bigint
        descriptionHash: Hex
      }
      out.push({
        jobId: args.jobId,
        buyer: args.buyer,
        provider: args.provider,
        amount: args.amount,
        descriptionHash: args.descriptionHash,
        blockNumber: l.blockNumber!,
        txHash: l.transactionHash!,
      })
    }
    out.sort((a, b) =>
      a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? -1 : 1,
    )
    return out
  }

  // ── private ──

  private _writeClient(): WalletClient {
    if (!this.walletClient) {
      throw new Error('AnimaMarket: walletClient required for write operations')
    }
    if (!this.walletClient.account) {
      throw new Error('walletClient missing account')
    }
    return this.walletClient
  }

  private async _send(
    fn: 'markDone' | 'acceptResult' | 'dispute' | 'claimTimeout' | 'proposeSplit' | 'forceClose',
    args: readonly unknown[],
  ): Promise<Hex> {
    const wc = this._writeClient()
    const data = encodeFunctionData({
      abi: ANIMA_MARKET_ABI,
      // biome-ignore lint/suspicious/noExplicitAny: viem function name typing
      functionName: fn as any,
      // biome-ignore lint/suspicious/noExplicitAny: viem args typing
      args: args as any,
    })
    return wc.sendTransaction({
      account: wc.account!,
      chain: wc.chain,
      to: this.address,
      data,
      value: 0n,
    })
  }
}
