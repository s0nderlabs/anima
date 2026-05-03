import type { PermissionDecision } from '@s0nderlabs/anima-core'
import {
  type HarnessEventKind,
  type ProvisionEnvelope,
  type RuntimeConfig,
  approvalResponseHash,
  chatMessageHash,
  provisionMessageHash,
} from '@s0nderlabs/anima-harness'
import type { Address, Hex, LocalAccount } from 'viem'

export interface SandboxClientOpts {
  /** Full base URL of the sandbox harness, e.g. `http://8080-<id>.43.106.147.28.nip.io:4000`. */
  endpoint: string
  /** Sandbox id (also embedded in nip.io URL). Used in chat sig anchoring. */
  sandboxId: string
  /** Operator wallet account that signs chat / approval / provision messages. */
  operator: LocalAccount
  /** Optional custom fetch implementation (used in tests). */
  fetchImpl?: typeof fetch
}

export interface ChatResponse {
  response: string
  toolCalls: Array<{ name: string; ok: boolean; durationMs: number }>
  durationMs: number
  syncTx?: string
}

export interface BootstrapPubkeyResponse {
  pubkeyHex: Hex
  version: string
  sandboxId: string
  state: string
  bootedAt: number
}

export interface HealthzResponse {
  state: string
  sandboxId: string
  version: string
  uptimeMs: number
  bootedAt: number
  provisionedAt: number | null
  readyAt: number | null
  agentAddress: Address | null
  runtimeReady: boolean
  eventsLastSeq: number
  subscribers: number
  pendingApprovals: number
}

export interface ProvisionPayload {
  envelope: ProvisionEnvelope
  /** Optional second envelope for harness secrets (telegram bot token etc). */
  secretsEnvelope?: ProvisionEnvelope
  iNFTRef: { contract: Address; tokenId: string }
  config: RuntimeConfig
}

export interface ParsedSseEvent {
  seq: number
  kind: HarnessEventKind
  ts: number
  data: unknown
}

/**
 * Thin client the laptop CLI uses to talk to the sandbox-resident harness.
 *
 * - Wraps EIP-191 signing for /chat, /provision, /approval/:id/respond
 * - Provides an async iterator over /events SSE
 * - Reconnects on stream drop using the last-event-id header
 */
export class SandboxClient {
  #fetch: typeof fetch
  endpoint: string
  sandboxId: string
  operator: LocalAccount

  constructor(opts: SandboxClientOpts) {
    this.endpoint = opts.endpoint.replace(/\/$/, '')
    this.sandboxId = opts.sandboxId
    this.operator = opts.operator
    this.#fetch = opts.fetchImpl ?? globalThis.fetch
  }

  async pubkey(): Promise<BootstrapPubkeyResponse> {
    const r = await this.#fetch(`${this.endpoint}/bootstrap/pubkey`)
    if (!r.ok) throw new Error(`pubkey: ${r.status}`)
    return (await r.json()) as BootstrapPubkeyResponse
  }

  async health(): Promise<HealthzResponse> {
    const r = await this.#fetch(`${this.endpoint}/healthz`)
    if (!r.ok) throw new Error(`healthz: ${r.status}`)
    return (await r.json()) as HealthzResponse
  }

  async waitReady(
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<HealthzResponse> {
    const timeoutMs = opts.timeoutMs ?? 120_000
    const intervalMs = opts.intervalMs ?? 1000
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const h = await this.health()
        if (h.state === 'Ready' && h.runtimeReady) return h
      } catch {
        // ignore transient errors during boot
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
    throw new Error(`waitReady timeout (${timeoutMs}ms)`)
  }

  async provision(
    payload: ProvisionPayload,
    bootstrapPubkey: Hex,
  ): Promise<{
    ok: boolean
    agentAddress: Address
    state: string
  }> {
    const ts = Date.now()
    const request = {
      envelope: payload.envelope,
      secretsEnvelope: payload.secretsEnvelope,
      operatorAddress: this.operator.address,
      iNFTRef: payload.iNFTRef,
      config: payload.config,
      ts,
    }
    const hash = provisionMessageHash(request, bootstrapPubkey)
    const signature = await this.operator.signMessage({ message: { raw: hash } })

    const r = await this.#fetch(`${this.endpoint}/bootstrap/provision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, signature }),
    })
    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      throw new Error(`provision failed (${r.status}): ${detail}`)
    }
    return (await r.json()) as { ok: boolean; agentAddress: Address; state: string }
  }

  async chat(message: string): Promise<ChatResponse> {
    const ts = Date.now()
    const hash = chatMessageHash(message, ts, this.sandboxId)
    const signature = await this.operator.signMessage({ message: { raw: hash } })

    const r = await this.#fetch(`${this.endpoint}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, ts, signature }),
    })
    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      throw new Error(`chat failed (${r.status}): ${detail}`)
    }
    return (await r.json()) as ChatResponse
  }

  async sync(): Promise<{ tx?: string; slots: string[] }> {
    const r = await this.#fetch(`${this.endpoint}/sync`, { method: 'POST' })
    if (!r.ok) throw new Error(`sync failed (${r.status})`)
    return (await r.json()) as { tx?: string; slots: string[] }
  }

  /**
   * Forward an operator approval decision to the harness. Maps anima's
   * `PermissionDecision` (`allow-once | allow-session | deny`) onto the
   * sandbox-server wire format (`allow | allow-session | deny`) since
   * `allow-once` collapses to `allow` over the wire — the harness's
   * ApprovalRelay only sees a once-shot resolve and the permission service
   * already handled session-allow caching there.
   */
  async approve(approvalId: string, decision: PermissionDecision): Promise<void> {
    const wireDecision: 'allow' | 'allow-session' | 'deny' =
      decision === 'allow-once' ? 'allow' : decision
    const ts = Date.now()
    const hash = approvalResponseHash({
      approvalId,
      decision: wireDecision,
      ts,
      sandboxId: this.sandboxId,
    })
    const signature = await this.operator.signMessage({ message: { raw: hash } })
    const r = await this.#fetch(`${this.endpoint}/approval/${approvalId}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: wireDecision, ts, signature }),
    })
    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      throw new Error(`approve failed (${r.status}): ${detail}`)
    }
  }

  /**
   * Subscribe to /events SSE. Yields parsed events. On stream drop, reconnects
   * with the last seen seq via the last-event-id header so we don't miss events.
   * Cancel via the AbortSignal in opts.
   */
  async *events(
    opts: { signal?: AbortSignal; sinceSeq?: number } = {},
  ): AsyncGenerator<ParsedSseEvent> {
    let lastSeq = opts.sinceSeq
    const signal = opts.signal
    while (true) {
      if (signal?.aborted) return
      const headers: Record<string, string> = { accept: 'text/event-stream' }
      if (typeof lastSeq === 'number') headers['last-event-id'] = String(lastSeq)
      let res: Response
      try {
        res = await this.#fetch(`${this.endpoint}/events`, { headers, signal })
      } catch {
        if (signal?.aborted) return
        await new Promise(resolve => setTimeout(resolve, 1000))
        continue
      }
      if (!res.ok || !res.body) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        continue
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      try {
        while (true) {
          if (signal?.aborted) return
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          for (;;) {
            const sep = buf.indexOf('\n\n')
            if (sep === -1) break
            const chunk = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            const ev = parseSseChunk(chunk)
            if (!ev) continue
            lastSeq = ev.seq
            yield ev
          }
        }
      } catch {
        // fallthrough: reconnect
      }
      if (signal?.aborted) return
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
}

function parseSseChunk(chunk: string): ParsedSseEvent | null {
  let id: number | null = null
  let kind: HarnessEventKind | null = null
  let dataLine = ''
  for (const rawLine of chunk.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('id: ')) {
      const n = Number.parseInt(line.slice(4), 10)
      if (Number.isFinite(n)) id = n
    } else if (line.startsWith('event: ')) {
      kind = line.slice(7) as HarnessEventKind
    } else if (line.startsWith('data: ')) {
      dataLine = dataLine ? `${dataLine}\n${line.slice(6)}` : line.slice(6)
    }
  }
  if (id == null || !kind || !dataLine) return null
  let parsed: { ts: number; data: unknown }
  try {
    parsed = JSON.parse(dataLine)
  } catch {
    return null
  }
  return { seq: id, kind, ts: parsed.ts, data: parsed.data }
}
