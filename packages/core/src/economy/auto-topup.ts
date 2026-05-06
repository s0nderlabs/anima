/**
 * v0.21.0 auto-topup manager.
 *
 * The agent funds its own bills out of its EOA. Currently this manager
 * only watches the COMPUTE provider envelope on 0G mainnet. When the
 * envelope drops below `compute.lowThreshold`, the manager refills it
 * by:
 *
 *   1. broker.ledger.depositFund(topUpAmount) — agent EOA → ledger total
 *   2. broker.ledger.transferFund(provider, topUpWei) — ledger total → provider envelope
 *
 * The agent's private key signs both transactions. The operator never
 * pays — this is the "agent wallet pays its own bills" mechanism the
 * operator asked for.
 *
 * Notification surface: the manager calls `onEvent` for every actionable
 * change. Callers (gateway) wire that into the EventHub so the TUI shows
 * a system row and TG sends a DM, AND append a row to the activity log.
 *
 * Hard cap: in-memory counter resets when the manager is constructed. Up
 * to `maxPerDay` topups per envelope per UTC day. Restarts reset the
 * counter — fine for hackathon scope, persistent counter is post-MVP.
 */

import type { Address, Hex } from 'viem'

export interface AutoTopupOpts {
  /** Whether the manager is allowed to top up. Default true (enabled). */
  enabled?: boolean
  /** How often to check balances. Default 5 minutes. */
  pollIntervalMs?: number
  compute?: {
    /**
     * If the per-provider envelope (in 0G) drops below this threshold, fire a
     * topup. Default 0.5 0G.
     */
    lowThreshold?: number
    /** Amount (in 0G) to deposit + transfer per topup. Default 1.0 0G. */
    topUpAmount?: number
    /** Max successful topups per provider per UTC day. Default 5. */
    maxPerDay?: number
    /** Provider address to monitor; usually the brain provider. */
    provider: Address
  }
  wallet?: {
    /**
     * If the agent EOA balance drops below this threshold (in 0G), emit a
     * `wallet-low` event so the operator gets notified. Notification only,
     * no action. Default 2.0 0G.
     */
    notifyThreshold?: number
    /**
     * Don't attempt a topup if doing so would leave the agent EOA with less
     * than this 0G after the deposit (gas buffer). Default 0.1 0G.
     */
    minRetainedAfterTopup?: number
  }
}

const DEFAULT_OPTS = {
  enabled: true,
  pollIntervalMs: 5 * 60 * 1000,
  compute: { lowThreshold: 0.5, topUpAmount: 1.0, maxPerDay: 5 },
  wallet: { notifyThreshold: 2.0, minRetainedAfterTopup: 0.1 },
} as const

export type AutoTopupEventKind =
  /** Compute envelope was below threshold; topup successfully fired and confirmed. */
  | 'topup-fired'
  /** Compute envelope was below threshold; topup attempted but failed (RPC/insufficient funds/cap). */
  | 'topup-failed'
  /** Agent EOA balance crossed the notify threshold downward. */
  | 'wallet-low'

export interface AutoTopupEvent {
  kind: AutoTopupEventKind
  /** Wall-clock ms timestamp. */
  ts: number
  /** Brief human-readable summary, suitable for a system row. */
  message: string
  /** Structured details. Shape depends on kind. */
  data: Record<string, unknown>
}

/**
 * Subset of the broker ledger surface we depend on. The real broker has many
 * more methods — narrowing here keeps the manager testable with a stub.
 */
export interface BrokerLedgerLike {
  getLedger(): Promise<{ availableBalance: bigint; totalBalance: bigint }>
  // Return tuple lifted to `string` (not Address) because the upstream SDK
  // types provider as plain string. We compare case-insensitively in tick().
  getProvidersWithBalance(
    serviceType: 'inference',
  ): Promise<Array<readonly [string, bigint, bigint]>>
  depositFund(amount: number): Promise<unknown>
  transferFund(provider: Address, serviceType: 'inference', amountWei: bigint): Promise<unknown>
}

/** The PublicClient subset we use for balance reads. */
export interface PublicClientLike {
  getBalance(opts: { address: Address }): Promise<bigint>
}

export interface AutoTopupDeps {
  agentAddress: Address
  publicClient: PublicClientLike
  /** Lazy: the broker takes seconds to spin up. We accept a getter so the manager doesn't block on construction. */
  getBrokerLedger(): Promise<BrokerLedgerLike | null>
  /** Notification sink; fires once per actionable change. */
  onEvent: (ev: AutoTopupEvent) => void
}

function ogToWei(amount: number): bigint {
  // Avoid float drift on large amounts. We accept up to 9 decimal places of
  // precision, so 0.123456789 * 1e9 = 123_456_789 → bigint multiply by 1e9.
  const scaled = Math.round(amount * 1e9)
  return BigInt(scaled) * 1_000_000_000n
}

function weiToOg(wei: bigint): number {
  // Lossy by design — used only for log strings, not on-chain math.
  return Number(wei) / 1e18
}

function utcDayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
}

/**
 * Per-envelope per-day topup counter. Restart-resets (in-memory). Keeps the
 * last 7 days to avoid unbounded growth, though we only ever read today's
 * count.
 */
class TopupCounter {
  #counts = new Map<string, number>() // `${envelope}:${dayKey}` → count

  count(envelope: string, ts: number): number {
    return this.#counts.get(`${envelope}:${utcDayKey(ts)}`) ?? 0
  }

  increment(envelope: string, ts: number): void {
    const key = `${envelope}:${utcDayKey(ts)}`
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1)
    this.#prune(ts)
  }

  #prune(ts: number): void {
    if (this.#counts.size <= 14) return
    const today = utcDayKey(ts)
    const keepWindow = 7 * 24 * 60 * 60 * 1000
    for (const key of this.#counts.keys()) {
      const day = key.split(':').slice(-1)[0]
      if (!day) continue
      if (day === today) continue
      const dayMs = Date.parse(`${day}T00:00:00Z`)
      if (Number.isFinite(dayMs) && ts - dayMs > keepWindow) this.#counts.delete(key)
    }
  }
}

export class AutoTopupManager {
  #opts: Required<AutoTopupOpts['compute'] & object> &
    Required<AutoTopupOpts['wallet'] & object> & {
      enabled: boolean
      pollIntervalMs: number
    }
  #deps: AutoTopupDeps
  #timer: ReturnType<typeof setInterval> | null = null
  #counter = new TopupCounter()
  #lastWalletBalanceWei: bigint | null = null
  #stopping = false

  constructor(opts: AutoTopupOpts, deps: AutoTopupDeps) {
    if (!opts.compute?.provider) throw new Error('compute.provider is required')
    this.#opts = {
      enabled: opts.enabled ?? DEFAULT_OPTS.enabled,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_OPTS.pollIntervalMs,
      provider: opts.compute.provider,
      lowThreshold: opts.compute.lowThreshold ?? DEFAULT_OPTS.compute.lowThreshold,
      topUpAmount: opts.compute.topUpAmount ?? DEFAULT_OPTS.compute.topUpAmount,
      maxPerDay: opts.compute.maxPerDay ?? DEFAULT_OPTS.compute.maxPerDay,
      notifyThreshold: opts.wallet?.notifyThreshold ?? DEFAULT_OPTS.wallet.notifyThreshold,
      minRetainedAfterTopup:
        opts.wallet?.minRetainedAfterTopup ?? DEFAULT_OPTS.wallet.minRetainedAfterTopup,
    }
    this.#deps = deps
  }

  start(): void {
    if (this.#timer) return
    if (!this.#opts.enabled) return
    // Fire-and-forget first tick so we react fast on boot, then poll.
    void this.tick().catch(() => {})
    this.#timer = setInterval(() => {
      void this.tick().catch(() => {})
    }, this.#opts.pollIntervalMs)
  }

  stop(): void {
    this.#stopping = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Public for tests + manual `anima topup status` triggering. One pass
   * over compute envelope + wallet balance.
   */
  async tick(): Promise<void> {
    if (this.#stopping) return
    const ts = Date.now()
    const broker = await this.#deps.getBrokerLedger()
    if (!broker) return
    let walletWei: bigint
    try {
      walletWei = await this.#deps.publicClient.getBalance({ address: this.#deps.agentAddress })
    } catch {
      return // transient RPC; don't emit, retry next tick
    }
    this.#maybeEmitWalletLow(walletWei, ts)

    let envelopes: Array<readonly [string, bigint, bigint]>
    try {
      envelopes = await broker.getProvidersWithBalance('inference')
    } catch {
      return
    }
    const ours = envelopes.find(
      ([provider]) => provider.toLowerCase() === this.#opts.provider.toLowerCase(),
    )
    const balanceWei = ours?.[1] ?? 0n
    const pendingRefundWei = ours?.[2] ?? 0n
    const availableWei = balanceWei - pendingRefundWei
    const lowThresholdWei = ogToWei(this.#opts.lowThreshold)
    if (availableWei >= lowThresholdWei) return

    // Below threshold; check cap.
    const todayCount = this.#counter.count(`compute:${this.#opts.provider}`, ts)
    if (todayCount >= this.#opts.maxPerDay) {
      this.#deps.onEvent({
        kind: 'topup-failed',
        ts,
        message: `compute envelope low (${weiToOg(availableWei).toFixed(3)} 0G) but daily cap reached (${todayCount}/${this.#opts.maxPerDay})`,
        data: {
          provider: this.#opts.provider,
          envelope: 'compute',
          envelopeBalance: weiToOg(availableWei),
          dailyCount: todayCount,
          dailyCap: this.#opts.maxPerDay,
          reason: 'daily-cap',
        },
      })
      return
    }

    const topUpWei = ogToWei(this.#opts.topUpAmount)
    const minRetainedWei = ogToWei(this.#opts.minRetainedAfterTopup)
    if (walletWei < topUpWei + minRetainedWei) {
      this.#deps.onEvent({
        kind: 'topup-failed',
        ts,
        message: `compute envelope low (${weiToOg(availableWei).toFixed(3)} 0G) but agent wallet too thin (${weiToOg(walletWei).toFixed(3)} 0G)`,
        data: {
          provider: this.#opts.provider,
          envelope: 'compute',
          envelopeBalance: weiToOg(availableWei),
          walletBalance: weiToOg(walletWei),
          required: this.#opts.topUpAmount + this.#opts.minRetainedAfterTopup,
          reason: 'insufficient-wallet',
        },
      })
      return
    }

    let depositTx: Hex | undefined
    let transferTx: Hex | undefined
    try {
      const depositResult = await broker.depositFund(this.#opts.topUpAmount)
      depositTx = (depositResult as { hash?: Hex } | undefined)?.hash
      const transferResult = await broker.transferFund(this.#opts.provider, 'inference', topUpWei)
      transferTx = (transferResult as { hash?: Hex } | undefined)?.hash
    } catch (err) {
      const message = (err as Error)?.message ?? 'unknown error'
      this.#deps.onEvent({
        kind: 'topup-failed',
        ts,
        message: `compute topup failed: ${message.slice(0, 200)}`,
        data: {
          provider: this.#opts.provider,
          envelope: 'compute',
          envelopeBalance: weiToOg(availableWei),
          error: message,
          reason: 'tx-failed',
        },
      })
      return
    }

    this.#counter.increment(`compute:${this.#opts.provider}`, ts)
    this.#deps.onEvent({
      kind: 'topup-fired',
      ts,
      message: `compute envelope topped up by ${this.#opts.topUpAmount} 0G (was ${weiToOg(availableWei).toFixed(3)} 0G)`,
      data: {
        provider: this.#opts.provider,
        envelope: 'compute',
        envelopeBalanceBefore: weiToOg(availableWei),
        topUpAmount: this.#opts.topUpAmount,
        depositTx,
        transferTx,
        dailyCount: todayCount + 1,
        dailyCap: this.#opts.maxPerDay,
      },
    })
  }

  #maybeEmitWalletLow(walletWei: bigint, ts: number): void {
    const thresholdWei = ogToWei(this.#opts.notifyThreshold)
    const wasAbove =
      this.#lastWalletBalanceWei == null || this.#lastWalletBalanceWei >= thresholdWei
    const nowBelow = walletWei < thresholdWei
    this.#lastWalletBalanceWei = walletWei
    if (wasAbove && nowBelow) {
      this.#deps.onEvent({
        kind: 'wallet-low',
        ts,
        message: `agent wallet below ${this.#opts.notifyThreshold} 0G (current: ${weiToOg(walletWei).toFixed(3)} 0G)`,
        data: {
          walletBalance: weiToOg(walletWei),
          notifyThreshold: this.#opts.notifyThreshold,
        },
      })
    }
  }
}
