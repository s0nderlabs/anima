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
import type { ChatTurnInput, ChatTurnResult, RuntimeAdapter, RuntimeConfig } from './runtime'

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
    })
    this.#runtime = runtime
    this.#events = opts.events
    this.#wireDrains(opts.events)
    this.#ready = true
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
    if (this.#pendingFlush) {
      await this.#pendingFlush.catch(() => {})
    }
    if (this.#runtime) {
      await this.#runtime.dispose()
      this.#runtime = null
    }
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
            events.publish('log', {
              level: 'error',
              message: `a2a turn failed: ${(err as Error).message}`,
            })
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
                  data: JSON.stringify({ ...e, jobId: e.jobId.toString() }),
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
            events.publish('log', {
              level: 'error',
              message: `market turn failed: ${(err as Error).message}`,
            })
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
