import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { explorerTxUrl, newEventId } from '@s0nderlabs/anima-core'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { ApprovalRelay } from './approval-relay'
import { type BuiltRuntime, buildAnimaRuntime } from './build-runtime'
import type { EventHub } from './events'
import type { ChatTurnInput, ChatTurnResult, RuntimeAdapter, RuntimeConfig } from './runtime'

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
    const turn = await r.brain.infer({
      event: {
        id: newEventId(),
        source: 'stdin',
        payload: { label: 'user-message', data: input.message },
        ts: input.ts,
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

    // Per-turn sync flush. Awaited here so the chat caller learns the txHash;
    // listeners drain after via background drain promise.
    let syncTx: string | undefined
    try {
      const flush = await r.sync.flushTurn()
      if (flush.txHash && flush.changedSlots.length > 0) {
        syncTx = flush.txHash
      }
    } catch {
      // Surface but don't fail the turn.
    }

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
      syncTx,
    }
  }

  async flushSync(): Promise<{ tx?: string; slots: string[] }> {
    if (!this.#runtime) throw new Error('runtime-not-started')
    const r = this.#runtime
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
