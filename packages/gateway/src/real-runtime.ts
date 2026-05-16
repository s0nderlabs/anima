import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPerms, applyYolo, explorerTxUrl, newEventId } from '@s0nderlabs/anima-core'
import { type ParsedBypass, parseBypassCommand } from '@s0nderlabs/anima-plugin-telegram'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { ApprovalRelay } from './approval-relay'
import { type BuiltRuntime, buildAnimaRuntime } from './build-runtime'
import type { EventHub } from './events'
import type {
  ChatTurnInput,
  ChatTurnResult,
  RuntimeAdapter,
  RuntimeConfig,
  TriggerTopupTickResult,
} from './runtime'

/**
 * Mirror of dispatchTelegramBypass for the TUI /chat HTTP path. Runs BEFORE
 * brain.infer so /yolo /perms /reset operate without burning compute.
 */
async function dispatchBypass(bypass: ParsedBypass, r: BuiltRuntime): Promise<string> {
  switch (bypass.command) {
    case '/stop':
      return 'no active turn to stop here.'
    case '/new':
    case '/reset':
      try {
        await r.brain.clearChannel('tui:stdin')
        return 'conversation reset (TUI channel cleared).'
      } catch (err) {
        return `reset failed: ${(err as Error).message?.slice(0, 200) ?? 'unknown'}`
      }
    case '/status':
      return 'idle.'
    case '/approve':
    case '/deny':
      return 'inline-keyboard approval is the supported path; click the buttons in the modal.'
    case '/yolo':
      return applyYolo(r.permission).message
    case '/perms':
      return applyPerms(r.permission, bypass.args[0]).message
    case '/background':
    case '/restart':
      return `${bypass.command} is reserved for a future bundle.`
  }
}

/**
 * v0.24.15: BigInt-safe JSON serialization for market event payloads.
 * Every JobEvent carries `blockNumber: bigint` plus kind-specific BigInts
 * (`amount` on `created`; `payout/fee` on `settled`; etc). The replacer
 * walks every field regardless of depth.
 */
export function stringifyMarketEvent(e: unknown): string {
  return JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
}

type DrainSource = 'a2a' | 'market'

/**
 * v0.24.16: shared drain-failure logger. Publishes a structured EventHub
 * `log` event AND mirrors to daemon stderr so silent failures surface in
 * `~/anima-logs/anima-gateway.log` without an SSE subscriber attached.
 *
 * Stderr is rate-limited per source: identical messages within
 * `STDERR_DEDUP_WINDOW_MS` only print once, so a stuck drain loop on a
 * persistent RPC error doesn't flood the log. EventHub publish always
 * fires so SSE subscribers see every occurrence.
 */
const STDERR_DEDUP_WINDOW_MS = 5000
const stderrLastSeen = new Map<string, number>()
function logTurnFailure(
  source: DrainSource,
  err: unknown,
  events: Pick<EventHub, 'publish'>,
): void {
  const msg = err instanceof Error ? err.message : String(err)
  events.publish('log', { level: 'error', message: `${source} turn failed: ${msg}` })
  const key = `${source}:${msg}`
  const now = Date.now()
  const last = stderrLastSeen.get(key) ?? 0
  if (now - last >= STDERR_DEDUP_WINDOW_MS) {
    stderrLastSeen.set(key, now)
    console.error(`[${source}] turn failed: ${msg}`)
  }
}

export interface RealRuntimeOpts {
  approvals: ApprovalRelay
  /** Optional override of the agent state directory. Default `${TMPDIR}/anima-gateway/<agentId>`. */
  agentDirRoot?: string
}

/**
 * Production runtime adapter. Builds the full anima brain + tools + plugins
 * + listeners + memory sync stack inside the sandbox container, exposes the
 * RuntimeAdapter contract that the harness HTTP server uses.
 *
 * Lifecycle:
 *   - `start()`: builds runtime, starts listeners (background), publishes
 *     ready event, transitions Provisioned → Ready.
 *   - `runChatTurn()`: brain.infer with stdin source, drains queued listener
 *     events afterwards, fires per-turn sync flush.
 *   - `flushSync()`: explicit sync.flushAll, surfaces tx + slots.
 *   - `stop()`: stops listeners, drains pending sync, releases plugins.
 */
export class RealRuntime implements RuntimeAdapter {
  #approvals: ApprovalRelay
  #agentDirRoot: string
  #runtime: BuiltRuntime | null = null
  #ready = false
  #stopping = false
  #drainInbound: (() => Promise<void>) | null = null
  #drainMarket: (() => Promise<void>) | null = null
  #network: '0g-mainnet' | '0g-testnet' | null = null
  #events: EventHub | null = null
  #pendingFlush: Promise<void> | null = null
  // Safety-net interval that periodically re-fires the drains in case a
  // wake-trigger callback was lost between the listener and the drain
  // queue (observed May 16 2026: 11 wakes queued, 0 brain inferences over
  // 14 minutes until restart). Drains have their own single-flight guards,
  // so this is a no-op when the queues are empty or a drain is already
  // running.
  #drainScanInterval: ReturnType<typeof setInterval> | null = null
  // v0.21.12: per-listener state for /healthz visibility.
  // Expanded to cover comms listeners so operators can spot a daemon whose
  // a2a-inbox / market subscription stalled mid-life (cursor advances but
  // history.db stops gaining rows — diagnosed May 16 2026).
  #listenerStates: Record<string, 'active' | 'disabled' | 'failed'> = {
    telegram: 'disabled',
    'a2a-inbox': 'disabled',
    'a2a-market': 'disabled',
  }

  constructor(opts: RealRuntimeOpts) {
    this.#approvals = opts.approvals
    this.#agentDirRoot = opts.agentDirRoot ?? join(tmpdir(), 'anima-gateway')
  }

  async start(opts: {
    agentPrivkey: Hex
    config: RuntimeConfig
    events: EventHub
    secrets?: import('./secrets').GatewaySecrets
  }): Promise<void> {
    const agentAddress = privateKeyToAccount(opts.agentPrivkey).address
    this.#network = opts.config.network
    const agentId = await this.#agentIdFromConfig(opts.config)
    const agentDir = join(this.#agentDirRoot, agentId)
    await mkdir(agentDir, { recursive: true })

    const runtime = await buildAnimaRuntime({
      config: opts.config,
      agentPrivkey: opts.agentPrivkey,
      agentAddress,
      agentDir,
      events: opts.events,
      approvals: this.#approvals,
      secrets: opts.secrets,
      // v0.24.11: autonomous brain wake on listener events. Without these
      // hooks, A2A inbound + market events queue but the brain never runs
      // until the operator's next chat turn. drainInbound / drainMarket are
      // wired by #wireDrains() below; we forward-bind the triggers to
      // arrow functions that look up the late-bound drains at fire time.
      onAutoTriggerInbox: () => {
        void this.#drainInbound?.()
      },
      onAutoTriggerMarket: () => {
        void this.#drainMarket?.()
      },
    })
    this.#runtime = runtime
    this.#events = opts.events
    this.#wireDrains(opts.events)
    // v0.24.11: an inbound that arrived BEFORE #wireDrains() set the drain
    // functions will have called `onAutoTriggerInbox` with the drain still
    // null. Drain explicitly here to catch the boot replay (the
    // `bootInbound.splice` loop in build-runtime fires before wireDrains).
    void this.#drainInbound?.()
    void this.#drainMarket?.()
    // v0.21.12: surface listener state for /healthz. The telegram listener is
    // 'active' when secrets were provided AND build-runtime registered the
    // listener (which requires both ctx.telegram + secrets.telegram). When
    // secrets.telegram is undefined (no encrypted blob, or missing scope key),
    // it's 'disabled'. Real start failures will be migrated to 'failed' once
    // we plumb startAll outcomes; right now buildAnimaRuntime swallows them.
    if (opts.secrets?.telegram && runtime.listeners.some(l => l.name === 'telegram-bot')) {
      this.#listenerStates.telegram = 'active'
    } else {
      this.#listenerStates.telegram = 'disabled'
    }
    // comms listeners register conditionally on plugins:[..., 'comms']. We treat
    // 'active' as registered + started; if buildAnimaRuntime swallowed a start
    // error it stays 'disabled' here (same caveat as telegram above).
    this.#listenerStates['a2a-inbox'] = runtime.listeners.some(l => l.name === 'a2a-inbox')
      ? 'active'
      : 'disabled'
    this.#listenerStates['a2a-market'] = runtime.listeners.some(l => l.name === 'a2a-market')
      ? 'active'
      : 'disabled'
    this.#drainScanInterval = setInterval(() => {
      const r = this.#runtime
      if (!r) return
      if (r.inboundQueue.length > 0) void this.#drainInbound?.()
      if (r.marketBrainQueue.length > 0) void this.#drainMarket?.()
    }, 30_000)
    this.#ready = true
  }

  listenerStates(): Record<string, 'active' | 'disabled' | 'failed'> {
    return { ...this.#listenerStates }
  }

  permissionMode(): 'off' | 'prompt' | 'strict' | undefined {
    return this.#runtime?.permission.getMode()
  }

  async runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    if (!this.#runtime) throw new Error('runtime-not-started')
    const r = this.#runtime
    await r.refreshUserContext()
    await r.activity.append({
      ts: Date.now(),
      kind: 'wake',
      data: { source: 'stdin', text: input.message },
    })
    const startedAt = Date.now()

    // v0.20.0: bypass commands (/yolo /perms /reset) intercept BEFORE brain.infer
    // so the TUI thin-client gets the same control surface as TG.
    const bypass = parseBypassCommand(input.message)
    if (bypass) {
      const reply = await dispatchBypass(bypass, r)
      return {
        response: reply,
        toolCalls: [],
        durationMs: Date.now() - startedAt,
      }
    }

    const turn = await r.brain.infer({
      event: {
        id: newEventId(),
        source: 'stdin',
        payload: { label: 'user-message', data: input.message },
        ts: input.ts,
      },
      channelKey: 'tui:stdin',
      onCompactionEvent: ev => {
        this.#events?.publish('context-compacted', ev)
        void r.activity
          .append({ ts: Date.now(), kind: 'context-compacted', data: ev })
          .catch(() => {})
      },
    })
    await r.activity.append({
      ts: Date.now(),
      kind: 'brain-response',
      data: {
        content: turn.content,
        toolCalls: turn.toolCalls.length,
        finishReason: turn.finishReason,
        usage: turn.usage,
      },
    })
    const durationMs = Date.now() - startedAt

    // Per-turn sync flush is BACKGROUND. Chain anchor on 0G mainnet takes
    // 30-60s; awaiting here would block the /chat HTTP response past Bun
    // fetch's idle timeout. The TUI subscribes to the `sync-flush` SSE
    // event for the txHash. Same pattern as the a2a/market drains below.
    void this.#fireBackgroundFlush()

    // Fire-and-forget drain of listener events that arrived during the turn.
    void this.#drainInbound?.()
    void this.#drainMarket?.()

    return {
      response: turn.content ?? '(no content)',
      toolCalls: turn.toolCalls.map(tc => ({
        name: tc.name,
        ok: true,
        durationMs: 0,
      })),
      durationMs,
    }
  }

  async #fireBackgroundFlush(): Promise<void> {
    const r = this.#runtime
    const events = this.#events
    if (!r || !events) return
    if (this.#pendingFlush) {
      // Coalesce: a flush is already in flight, the next turn's writes
      // will ride on its (or the next) cycle.
      return
    }
    const p = (async () => {
      try {
        const flush = await r.sync.flushTurn()
        if (flush.txHash && flush.changedSlots.length > 0 && this.#network) {
          events.publish('sync-flush', {
            txHash: flush.txHash,
            slots: flush.changedSlots,
            explorer: explorerTxUrl(this.#network, flush.txHash),
          })
        }
      } catch (err) {
        events.publish('log', {
          level: 'error',
          message: `sync flush failed: ${(err as Error).message}`,
        })
      } finally {
        this.#pendingFlush = null
      }
    })()
    this.#pendingFlush = p
  }

  async flushSync(): Promise<{ tx?: string; slots: string[] }> {
    if (!this.#runtime) throw new Error('runtime-not-started')
    const r = this.#runtime
    if (this.#pendingFlush) {
      await this.#pendingFlush.catch(() => {})
    }
    const result = await r.sync.flushAll()
    return {
      tx: result.txHash ?? undefined,
      slots: result.changedSlots,
    }
  }

  ready(): boolean {
    return this.#ready
  }

  async stop(): Promise<void> {
    if (this.#stopping) return
    this.#stopping = true
    this.#ready = false
    if (this.#drainScanInterval) {
      clearInterval(this.#drainScanInterval)
      this.#drainScanInterval = null
    }
    if (this.#pendingFlush) {
      await this.#pendingFlush.catch(() => {})
    }
    if (this.#runtime) {
      await this.#runtime.dispose()
      this.#runtime = null
    }
  }

  /**
   * v0.21.5: manually trigger one AutoTopupManager poll. Used by the admin
   * endpoint POST /admin/autotopup/tick to live-fire topup events without
   * waiting for the 5-minute poll interval. Outcome flows through the
   * existing event/activity-log surfaces, NOT this return value.
   */
  async triggerTopupTick(): Promise<TriggerTopupTickResult> {
    if (!this.#runtime) return { ok: false, reason: 'runtime-not-started' }
    if (!this.#runtime.autoTopup) return { ok: false, reason: 'autotopup-disabled' }
    try {
      await this.#runtime.autoTopup.tick()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: (err as Error).message?.slice(0, 200) ?? 'tick-failed' }
    }
  }

  /**
   * v0.23.0: snapshot of every IntelligentData slot's high-level state for
   * /healthz. Populated by the boot-time restore + lazy retries + successful
   * flushes. Empty before the runtime is started.
   */
  slotStatus(): Record<string, { status: string; reason?: string; bytes?: number }> {
    if (!this.#runtime) return {}
    const out: Record<string, { status: string; reason?: string; bytes?: number }> = {}
    for (const [slot, status] of this.#runtime.slotStatus.entries()) {
      out[slot] = status
    }
    return out
  }

  /**
   * v0.23.0: live-flip the operator-scoped PROFILE key. Called by the
   * /admin/profile-key endpoint after operator-sig verification succeeds.
   * Forwards to the BuiltRuntime closure that updates MemorySyncManager +
   * fires a one-shot restore for the profile slot.
   */
  async setProfileKey(
    keyHex: `0x${string}`,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.#runtime) return { ok: false, reason: 'runtime-not-started' }
    return this.#runtime.setProfileKey(keyHex)
  }

  /**
   * v0.24.4: approve a pending pairing code in the container's pairing dir.
   * Called by the `/admin/pairing/approve` endpoint after operator-sig
   * verification succeeds. Forwards to `BuiltRuntime.approvePairing` which
   * wraps `PairingStore.approveCode` with the locked-out vs unknown-code
   * branching the HTTP layer needs.
   */
  approvePairing(
    platform: string,
    code: string,
  ): { ok: true; userId: string; userName: string } | { ok: false; reason: string } {
    if (!this.#runtime) return { ok: false, reason: 'runtime-not-started' }
    return this.#runtime.approvePairing(platform, code)
  }

  // Wire the drainers. Each pulls from the queue, runs brain.infer with the
  // appropriate source, persists activity entries, fires sync flush. Mirrors
  // chat.tsx local-mode but surfaces output via EventHub instead of TUI rows.
  #wireDrains(events: EventHub): void {
    let drainingInbound = false
    let drainingMarket = false

    this.#drainInbound = async (): Promise<void> => {
      if (drainingInbound) return
      const r = this.#runtime
      if (!r || r.inboundQueue.length === 0) return
      drainingInbound = true
      try {
        while (r.inboundQueue.length > 0) {
          const m = r.inboundQueue.shift()!
          await r.refreshUserContext()
          await r.activity.append({
            ts: Date.now(),
            kind: 'wake',
            data: { source: 'a2a', from: m.from, txHash: m.txHash },
          })
          const channelText =
            m.envelope.type === 'msg'
              ? `<channel source="anima.inbox" from="${m.fromLabel ?? m.from}">${m.envelope.content}</channel>`
              : `<channel source="anima.inbox" from="${m.fromLabel ?? m.from}" file="${m.envelope.filename}" size="${m.envelope.size}"/>`
          try {
            const turn = await r.brain.infer({
              event: {
                id: newEventId(),
                source: 'a2a',
                payload: { label: 'inbound-message', data: channelText, peer: m.from },
                ts: Date.now(),
              },
              channelKey: `a2a:${m.from}`,
            })
            await r.activity.append({
              ts: Date.now(),
              kind: 'brain-response',
              data: {
                content: turn.content,
                toolCalls: turn.toolCalls.length,
                finishReason: turn.finishReason,
                usage: turn.usage,
              },
            })
            events.publish('turn-end', {
              source: 'a2a',
              content: turn.content,
              toolCalls: turn.toolCalls.length,
            })
            const flush = await r.sync.flushTurn().catch(() => null)
            if (flush?.txHash && flush.changedSlots.length > 0 && this.#network) {
              events.publish('sync-flush', {
                txHash: flush.txHash,
                slots: flush.changedSlots,
                explorer: explorerTxUrl(this.#network, flush.txHash),
              })
            }
          } catch (err) {
            logTurnFailure('a2a', err, events)
          }
        }
      } finally {
        drainingInbound = false
      }
    }

    this.#drainMarket = async (): Promise<void> => {
      if (drainingMarket) return
      const r = this.#runtime
      if (!r || r.marketBrainQueue.length === 0) return
      drainingMarket = true
      try {
        while (r.marketBrainQueue.length > 0) {
          const e = r.marketBrainQueue.shift()!
          await r.refreshUserContext()
          await r.activity.append({
            ts: Date.now(),
            kind: 'wake',
            data: { source: 'market', kind: e.kind, jobId: e.jobId.toString(), txHash: e.txHash },
          })
          try {
            const turn = await r.brain.infer({
              event: {
                id: newEventId(),
                source: 'marketplace',
                payload: {
                  label: `market:${e.kind}`,
                  data: stringifyMarketEvent(e),
                },
                ts: Date.now(),
              },
              channelKey: 'marketplace',
            })
            await r.activity.append({
              ts: Date.now(),
              kind: 'brain-response',
              data: {
                content: turn.content,
                toolCalls: turn.toolCalls.length,
                finishReason: turn.finishReason,
                usage: turn.usage,
              },
            })
            events.publish('turn-end', {
              source: 'market',
              content: turn.content,
              toolCalls: turn.toolCalls.length,
            })
            const flush = await r.sync.flushTurn().catch(() => null)
            if (flush?.txHash && flush.changedSlots.length > 0 && this.#network) {
              events.publish('sync-flush', {
                txHash: flush.txHash,
                slots: flush.changedSlots,
                explorer: explorerTxUrl(this.#network, flush.txHash),
              })
            }
          } catch (err) {
            logTurnFailure('market', err, events)
          }
        }
      } finally {
        drainingMarket = false
      }
    }
  }

  async #agentIdFromConfig(config: RuntimeConfig): Promise<string> {
    const { iNFTAgentId } = await import('@s0nderlabs/anima-core')
    return iNFTAgentId({
      contractAddress: config.identity.iNFT.contract,
      tokenId: BigInt(config.identity.iNFT.tokenId),
    })
  }
}
