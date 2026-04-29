import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
  parseAbi,
} from 'viem'

/**
 * AnimaInbox singleton ABI. Matches `contracts/src/AnimaInbox.sol`.
 */
export const ANIMA_INBOX_ABI = parseAbi([
  'event Message(address indexed from, address indexed to, bytes payload, bytes32 dataHash)',
  'function sendMessage(address to, bytes payload, bytes32 dataHash) external',
  'function MAX_INLINE_PAYLOAD() view returns (uint256)',
  'error InvalidRecipient()',
  'error EmptyMessage()',
  'error PayloadTooLarge()',
])

export interface InboxMessageEvent {
  from: Address
  to: Address
  payload: Hex
  dataHash: Hex
  blockNumber: bigint
  txHash: Hex
  logIndex: number
}

export interface InboxClientOpts {
  /** Deployed AnimaInbox singleton on the agent's network. */
  address: Address
  /** Read client (for getLogs + watchEvent + balance). */
  publicClient: PublicClient
  /** Optional write client (only needed to call sendMessage). */
  walletClient?: WalletClient
  /** Agent privkey, used when walletClient is built lazily. */
  privkeyHex?: Hex
}

export class AnimaInboxClient {
  readonly address: Address
  private readonly publicClient: PublicClient
  private readonly walletClient: WalletClient | null
  private readonly privkeyHex: Hex | null

  constructor(opts: InboxClientOpts) {
    this.address = opts.address
    this.publicClient = opts.publicClient
    this.walletClient = opts.walletClient ?? null
    this.privkeyHex = opts.privkeyHex ?? null
    if (!this.walletClient && !this.privkeyHex) {
      // read-only is fine but flag for future writes
    }
  }

  /**
   * Broadcast a Message event. Returns the tx hash.
   */
  async send(to: Address, payload: Hex, dataHash: Hex): Promise<Hex> {
    if (!this.walletClient) {
      if (!this.privkeyHex) {
        throw new Error('AnimaInbox.send requires walletClient or privkeyHex')
      }
      // Caller didn't supply a walletClient; we can't synthesize one without
      // a chain reference. Refuse rather than guess.
      throw new Error(
        'AnimaInbox.send: walletClient missing. Build a WalletClient with the agent privkey + chain.',
      )
    }
    const account = this.walletClient.account
    if (!account) throw new Error('walletClient missing account')
    const data = encodeFunctionData({
      abi: ANIMA_INBOX_ABI,
      functionName: 'sendMessage',
      args: [to, payload, dataHash],
    })
    const hash = await this.walletClient.sendTransaction({
      account,
      chain: this.walletClient.chain,
      to: this.address,
      data,
      value: 0n,
    })
    return hash
  }

  /**
   * Fetch all Message events for `recipient` in [fromBlock, toBlock]. The
   * caller is responsible for chunking ranges that exceed RPC limits.
   */
  async getMessagesFor(
    recipient: Address,
    fromBlock: bigint,
    toBlock: bigint | 'latest' = 'latest',
  ): Promise<InboxMessageEvent[]> {
    const logs = await this.publicClient.getLogs({
      address: this.address,
      event: {
        type: 'event',
        name: 'Message',
        inputs: [
          { name: 'from', type: 'address', indexed: true },
          { name: 'to', type: 'address', indexed: true },
          { name: 'payload', type: 'bytes' },
          { name: 'dataHash', type: 'bytes32' },
        ],
      },
      args: { to: recipient },
      fromBlock,
      toBlock,
    })
    return logs.map(l => ({
      from: l.args.from as Address,
      to: l.args.to as Address,
      payload: l.args.payload as Hex,
      dataHash: l.args.dataHash as Hex,
      blockNumber: l.blockNumber!,
      txHash: l.transactionHash!,
      logIndex: Number(l.logIndex),
    }))
  }

  /**
   * Subscribe live to Message events targeting `recipient`. Returns an
   * unwatch handle.
   */
  watchMessagesFor(recipient: Address, onEvent: (m: InboxMessageEvent) => void): () => void {
    return this.publicClient.watchContractEvent({
      address: this.address,
      abi: ANIMA_INBOX_ABI,
      eventName: 'Message',
      args: { to: recipient },
      onLogs: logs => {
        for (const l of logs) {
          onEvent({
            from: l.args.from as Address,
            to: l.args.to as Address,
            payload: l.args.payload as Hex,
            dataHash: l.args.dataHash as Hex,
            blockNumber: l.blockNumber!,
            txHash: l.transactionHash!,
            logIndex: Number(l.logIndex),
          })
        }
      },
    })
  }
}
