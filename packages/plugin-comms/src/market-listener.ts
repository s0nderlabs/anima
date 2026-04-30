import type { Address, Hex, PublicClient } from 'viem'
import { ANIMA_MARKET_ABI, type AnimaMarketClient, type JobCreatedEvent } from './market'

type LifecycleEventName =
  | 'JobMarkedDone'
  | 'JobAccepted'
  | 'JobDisputed'
  | 'JobSettled'
  | 'SplitProposed'
  | 'SplitResolved'
  | 'JobForceClosed'

const LIFECYCLE_EVENTS = {
  JobMarkedDone: {
    type: 'event',
    name: 'JobMarkedDone',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'doneAt', type: 'uint256' },
    ],
  },
  JobAccepted: {
    type: 'event',
    name: 'JobAccepted',
    inputs: [{ name: 'jobId', type: 'uint256', indexed: true }],
  },
  JobDisputed: {
    type: 'event',
    name: 'JobDisputed',
    inputs: [{ name: 'jobId', type: 'uint256', indexed: true }],
  },
  JobSettled: {
    type: 'event',
    name: 'JobSettled',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'payout', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
    ],
  },
  SplitProposed: {
    type: 'event',
    name: 'SplitProposed',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'proposer', type: 'address', indexed: true },
      { name: 'buyerAmount', type: 'uint256' },
      { name: 'providerAmount', type: 'uint256' },
    ],
  },
  SplitResolved: {
    type: 'event',
    name: 'SplitResolved',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'buyerPayout', type: 'uint256' },
      { name: 'providerPayout', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
    ],
  },
  JobForceClosed: {
    type: 'event',
    name: 'JobForceClosed',
    inputs: [{ name: 'jobId', type: 'uint256', indexed: true }],
  },
} as const

/**
 * Listener for AnimaMarket events affecting the agent. Mirrors A2AListener
 * pattern: catch-up via getLogs from startBlock, then WS subscribe for live.
 *
 * The agent is a party (buyer or provider) on a job iff a JobCreated event
 * with that role exists. We track the local set of relevant jobIds and
 * filter all subsequent lifecycle events client-side.
 *
 * Single onJobEvent callback receives every event that targets a relevant
 * job. Caller (chat.tsx) decides how to surface them in TUI.
 */

export type JobEvent =
  | {
      kind: 'created'
      jobId: bigint
      buyer: Address
      provider: Address
      amount: bigint
      descriptionHash: Hex
      blockNumber: bigint
      txHash: Hex
    }
  | {
      kind: 'markedDone'
      jobId: bigint
      doneAt: bigint
      blockNumber: bigint
      txHash: Hex
    }
  | { kind: 'accepted'; jobId: bigint; blockNumber: bigint; txHash: Hex }
  | { kind: 'disputed'; jobId: bigint; blockNumber: bigint; txHash: Hex }
  | {
      kind: 'settled'
      jobId: bigint
      recipient: Address
      payout: bigint
      fee: bigint
      blockNumber: bigint
      txHash: Hex
    }
  | {
      kind: 'splitProposed'
      jobId: bigint
      proposer: Address
      buyerAmount: bigint
      providerAmount: bigint
      blockNumber: bigint
      txHash: Hex
    }
  | {
      kind: 'splitResolved'
      jobId: bigint
      buyerPayout: bigint
      providerPayout: bigint
      fee: bigint
      blockNumber: bigint
      txHash: Hex
    }
  | { kind: 'forceClosed'; jobId: bigint; blockNumber: bigint; txHash: Hex }

export interface MarketListenerOpts {
  agentEoa: Address
  market: AnimaMarketClient
  publicClient: PublicClient
  startBlock: bigint
  onEvent: (event: JobEvent) => void
}

export class MarketListener {
  private readonly opts: MarketListenerOpts
  private readonly relevantJobIds = new Set<string>()
  private unwatchers: Array<() => void> = []
  private running = false
  private cursorBlock = 0n

  constructor(opts: MarketListenerOpts) {
    this.opts = opts
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.cursorBlock =
      this.opts.startBlock > 0n
        ? this.opts.startBlock
        : await this.opts.publicClient.getBlockNumber()
    await this.catchUp()
    this.subscribe()
  }

  stop(): void {
    this.running = false
    for (const u of this.unwatchers) u()
    this.unwatchers = []
  }

  /** Test/UX helper. */
  isRelevant(jobId: bigint): boolean {
    return this.relevantJobIds.has(jobId.toString())
  }

  // ── catch up ──

  private async catchUp(): Promise<void> {
    const head = await this.opts.publicClient.getBlockNumber()

    // 1. JobCreated where agent is buyer or provider
    const creates = await this.opts.market.getJobsCreatedBy(
      this.opts.agentEoa,
      this.cursorBlock,
      head,
    )
    for (const c of creates) {
      this.relevantJobIds.add(c.jobId.toString())
      this.opts.onEvent({
        kind: 'created',
        jobId: c.jobId,
        buyer: c.buyer,
        provider: c.provider,
        amount: c.amount,
        descriptionHash: c.descriptionHash,
        blockNumber: c.blockNumber,
        txHash: c.txHash,
      })
    }

    if (this.relevantJobIds.size === 0) {
      this.cursorBlock = head
      return
    }

    // 2. All lifecycle events filtered by jobId in our set
    await this.catchUpLifecycle(this.cursorBlock, head)
    this.cursorBlock = head
  }

  private async catchUpLifecycle(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const eventNames: LifecycleEventName[] = [
      'JobMarkedDone',
      'JobAccepted',
      'JobDisputed',
      'JobSettled',
      'SplitProposed',
      'SplitResolved',
      'JobForceClosed',
    ]

    // Parallel getLogs across all 7 lifecycle events. ~7x faster than serial
    // on networks with non-trivial RPC latency. Order is preserved within
    // each event type by chain order; cross-type ordering is best-effort
    // (block→txIdx→logIdx). Listener consumers don't depend on strict cross-
    // type ordering — each event is self-describing.
    const allLogs = await Promise.all(
      eventNames.map(name =>
        this.opts.publicClient
          .getLogs({
            address: this.opts.market.address,
            event: LIFECYCLE_EVENTS[name],
            fromBlock,
            toBlock,
          })
          .then(logs => logs.map(l => ({ name, log: l }))),
      ),
    )

    for (const batch of allLogs) {
      for (const { name, log: l } of batch) {
        const args = (l as unknown as { args: Record<string, unknown> }).args
        const jobId = args.jobId as bigint
        if (!this.relevantJobIds.has(jobId.toString())) continue
        const ev = decodeJobEvent(name, jobId, args, l.blockNumber, l.transactionHash)
        if (ev) this.opts.onEvent(ev)
      }
    }
  }

  // ── live subscribe ──

  private subscribe(): void {
    const market = this.opts.market

    // JobCreated (filter on indexed buyer = agent OR provider = agent)
    const onCreate = (event: JobCreatedEvent) => {
      const k = event.jobId.toString()
      if (this.relevantJobIds.has(k)) return
      this.relevantJobIds.add(k)
      this.opts.onEvent({
        kind: 'created',
        jobId: event.jobId,
        buyer: event.buyer,
        provider: event.provider,
        amount: event.amount,
        descriptionHash: event.descriptionHash,
        blockNumber: event.blockNumber,
        txHash: event.txHash,
      })
    }

    this.unwatchers.push(
      this.opts.publicClient.watchContractEvent({
        address: market.address,
        abi: ANIMA_MARKET_ABI,
        eventName: 'JobCreated',
        args: { buyer: this.opts.agentEoa },
        onLogs: logs => {
          for (const l of logs) {
            onCreate({
              jobId: l.args.jobId as bigint,
              buyer: l.args.buyer as Address,
              provider: l.args.provider as Address,
              amount: l.args.amount as bigint,
              descriptionHash: l.args.descriptionHash as Hex,
              blockNumber: l.blockNumber!,
              txHash: l.transactionHash!,
            })
          }
        },
      }),
    )

    this.unwatchers.push(
      this.opts.publicClient.watchContractEvent({
        address: market.address,
        abi: ANIMA_MARKET_ABI,
        eventName: 'JobCreated',
        args: { provider: this.opts.agentEoa },
        onLogs: logs => {
          for (const l of logs) {
            onCreate({
              jobId: l.args.jobId as bigint,
              buyer: l.args.buyer as Address,
              provider: l.args.provider as Address,
              amount: l.args.amount as bigint,
              descriptionHash: l.args.descriptionHash as Hex,
              blockNumber: l.blockNumber!,
              txHash: l.transactionHash!,
            })
          }
        },
      }),
    )

    // Lifecycle events: subscribe to all, filter by jobId set client-side.
    const lifecycleSubs: LifecycleEventName[] = [
      'JobMarkedDone',
      'JobAccepted',
      'JobDisputed',
      'JobSettled',
      'SplitProposed',
      'SplitResolved',
      'JobForceClosed',
    ]
    for (const name of lifecycleSubs) {
      this.unwatchers.push(
        this.opts.publicClient.watchContractEvent({
          address: market.address,
          abi: ANIMA_MARKET_ABI,
          eventName: name,
          onLogs: logs => {
            for (const l of logs) {
              const args = (l as unknown as { args: Record<string, unknown> }).args
              const jobId = args.jobId as bigint
              if (!this.relevantJobIds.has(jobId.toString())) continue
              const ev = decodeJobEvent(name, jobId, args, l.blockNumber, l.transactionHash)
              if (ev) this.opts.onEvent(ev)
            }
          },
        }),
      )
    }
  }
}

// ── helpers ──

function decodeJobEvent(
  name: string,
  jobId: bigint,
  args: Record<string, unknown>,
  blockNumberRaw: bigint | null,
  txHashRaw: Hex | null,
): JobEvent | null {
  const blockNumber = blockNumberRaw ?? 0n
  const txHash = txHashRaw ?? ('0x' as Hex)
  switch (name) {
    case 'JobMarkedDone':
      return {
        kind: 'markedDone',
        jobId,
        doneAt: args.doneAt as bigint,
        blockNumber,
        txHash,
      }
    case 'JobAccepted':
      return { kind: 'accepted', jobId, blockNumber, txHash }
    case 'JobDisputed':
      return { kind: 'disputed', jobId, blockNumber, txHash }
    case 'JobSettled':
      return {
        kind: 'settled',
        jobId,
        recipient: args.recipient as Address,
        payout: args.payout as bigint,
        fee: args.fee as bigint,
        blockNumber,
        txHash,
      }
    case 'SplitProposed':
      return {
        kind: 'splitProposed',
        jobId,
        proposer: args.proposer as Address,
        buyerAmount: args.buyerAmount as bigint,
        providerAmount: args.providerAmount as bigint,
        blockNumber,
        txHash,
      }
    case 'SplitResolved':
      return {
        kind: 'splitResolved',
        jobId,
        buyerPayout: args.buyerPayout as bigint,
        providerPayout: args.providerPayout as bigint,
        fee: args.fee as bigint,
        blockNumber,
        txHash,
      }
    case 'JobForceClosed':
      return { kind: 'forceClosed', jobId, blockNumber, txHash }
    default:
      return null
  }
}
