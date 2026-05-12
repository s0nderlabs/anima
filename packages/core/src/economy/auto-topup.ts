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
  // lowThreshold raised from 0.5 → 1.7: per-inference cost on qwen3.6-plus
  // locks ~1.6 0G in the provider sub-account before the call runs. 0.5
  // left zero headroom and the brain failed mid-turn with "sub-account
  // short" before auto-topup ever fired. 1.7 keeps a thin margin above the
  // typical lock without firing aggressively when the envelope is in the
  // 1.5-1.7 mid-conversation range. The cool-down logic in `tick()` also
  // suppresses repeat failed-wallet emissions so a thin EOA doesn't spam.
  compute: { lowThreshold: 1.7, topUpAmount: 1.0, maxPerDay: 5 },
  wallet: { notifyThreshold: 2.0, minRetainedAfterTopup: 0.1 },
} as const

export type AutoTopupEventKind =
  /** Compute envelope was below threshold; topup successfully fired and confirmed. */
  | 'topup-fired'
  /** Compute envelope was below threshold; topup attempted but failed (RPC/insufficient funds/cap). */
  | 'topup-failed'
  /** Agent EOA balance crossed the notify threshold downward. */
  | 'wallet-low'
  /** v0.21.4: topup tick observed but skipped (broker not ready, RPC error). Visibility into a polling manager that would otherwise be silent. */
  | 'topup-skipped'

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
  /**
   * v0.21.5: when the broker is null (typically because brain.init() hasn't
   * fired yet — broker is lazy on first infer), AutoTopupManager will call
   * this once and re-check getBrokerLedger before emitting topup-skipped.
   * Without this, an idle agent (no chat turns) would never autotopup until
   * the operator types something. With it, the manager wakes the broker on
   * the first poll tick. Optional — if absent, manager preserves the
   * v0.21.4 broker-not-ready skipped behavior.
   */
  getBrainInit?: () => Promise<void>
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
  /**
   * v0.21.5: once getBrainInit fails, back off subsequent retries to avoid
   * hammering brain.init() every 5 minutes for the same dead provider. Reset
   * to null when a tick observes a non-null broker (init eventually
   * succeeded) so a transient failure doesn't permanently disable the wake.
   */
  #brainInitFailedAt: number | null = null
  /** Min ms between brain.init() retries after a failure. Default 1 hour. */
  #brainInitRetryCooldownMs = 60 * 60 * 1000
  /**
   * Suppress repeat insufficient-wallet failures: when the agent EOA can't
   * cover a 1 0G topup, we'd otherwise emit one topup-failed event per poll
   * (every 60s on specter). Operators see a wall of identical sys rows in
   * the TUI. Track the last failure ts + back off subsequent retries for
   * 10 minutes so the chat stays readable and on-chain transfer attempts
   * don't pile up.
   */
  #insufficientWalletFailedAt: number | null = null
  #insufficientWalletCooldownMs = 10 * 60 * 1000

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
    let broker = await this.#deps.getBrokerLedger()
    // v0.21.5: an idle agent (no chat turns yet) keeps the broker null until
    // brain.init() runs. If the caller wired getBrainInit, eagerly trigger
    // init on the first null-ledger tick so an unattended agent can still
    // refill its compute envelope without operator intervention.
    if (broker) {
      // Init eventually succeeded; clear any back-off so the next failure
      // gets one fresh attempt before the cooldown kicks in.
      this.#brainInitFailedAt = null
    } else if (this.#deps.getBrainInit) {
      const cooledDown =
        this.#brainInitFailedAt === null ||
        ts - this.#brainInitFailedAt >= this.#brainInitRetryCooldownMs
      if (!cooledDown) {
        this.#deps.onEvent({
          kind: 'topup-skipped',
          ts,
          message: 'auto-topup waiting for brain broker (init backoff)',
          data: { reason: 'broker-not-ready', backoffUntil: this.#brainInitFailedAt },
        })
        return
      }
      try {
        await this.#deps.getBrainInit()
        broker = await this.#deps.getBrokerLedger()
        if (broker) this.#brainInitFailedAt = null
      } catch (err) {
        this.#brainInitFailedAt = ts
        const errMsg = (err as Error)?.message?.slice(0, 200) ?? 'unknown'
        this.#deps.onEvent({
          kind: 'topup-skipped',
          ts,
          message: `auto-topup tried to wake brain broker but init failed: ${errMsg}`,
          data: { reason: 'broker-not-ready', initError: errMsg },
        })
        return
      }
    }
    if (!broker) {
      // v0.21.4: emit topup-skipped so operators can see the manager IS running
      // but is waiting for the brain to lazy-init the broker. Without this,
      // the absence of any auto-topup events looks identical to "manager not
      // started" and is undebuggable.
      this.#deps.onEvent({
        kind: 'topup-skipped',
        ts,
        message: 'auto-topup waiting for brain broker to initialize',
        data: { reason: 'broker-not-ready' },
      })
      return
    }
    let walletWei: bigint
    try {
      walletWei = await this.#deps.publicClient.getBalance({ address: this.#deps.agentAddress })
    } catch (err) {
      this.#deps.onEvent({
        kind: 'topup-skipped',
        ts,
        message: `auto-topup wallet read failed: ${(err as Error).message?.slice(0, 100) ?? 'unknown'}`,
        data: { reason: 'wallet-rpc-error', error: String(err) },
      })
      return
    }
    this.#maybeEmitWalletLow(walletWei, ts)

    let envelopes: Array<readonly [string, bigint, bigint]>
    try {
      envelopes = await broker.getProvidersWithBalance('inference')
    } catch (err) {
      this.#deps.onEvent({
        kind: 'topup-skipped',
        ts,
        message: `auto-topup provider read failed: ${(err as Error).message?.slice(0, 100) ?? 'unknown'}`,
        data: { reason: 'provider-rpc-error', error: String(err) },
      })
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
      // Suppress repeat emissions during the cool-down window. Without
      // this, the AutoTopupManager spams one topup-failed sys row per
      // poll (60s on specter) for as long as the operator keeps the
      // wallet thin — visually drowns the TUI.
      const recentlyFailed =
        this.#insufficientWalletFailedAt !== null &&
        ts - this.#insufficientWalletFailedAt < this.#insufficientWalletCooldownMs
      if (recentlyFailed) return
      this.#insufficientWalletFailedAt = ts
      this.#deps.onEvent({
        kind: 'topup-failed',
        ts,
        message: `compute envelope low (${weiToOg(availableWei).toFixed(3)} 0G) but agent wallet too thin (${weiToOg(walletWei).toFixed(3)} 0G); will retry in ${Math.round(this.#insufficientWalletCooldownMs / 60_000)} min`,
        data: {
          provider: this.#opts.provider,
          envelope: 'compute',
          envelopeBalance: weiToOg(availableWei),
          walletBalance: weiToOg(walletWei),
          required: this.#opts.topUpAmount + this.#opts.minRetainedAfterTopup,
          reason: 'insufficient-wallet',
          cooldownMs: this.#insufficientWalletCooldownMs,
        },
      })
      return
    }
    // Wallet check passed — clear cool-down so a future thin-wallet event
    // emits immediately rather than waiting another 10 min.
    this.#insufficientWalletFailedAt = null

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
