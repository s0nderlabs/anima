import type { PermissionDecision } from '@s0nderlabs/anima-core'
import {
  type GatewayEventKind,
  type ProvisionEnvelope,
  type RuntimeConfig,
  adminTickHash,
  approvalResponseHash,
  chatMessageHash,
  provisionMessageHash,
} from '@s0nderlabs/anima-gateway'
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
  /**
   * Optional unix socket path. When set, every fetch call routes via the
   * socket using Bun's `fetch(url, {unix: '/path'})` option. The endpoint
   * URL's host doesn't matter (kernel routes via socket); we use
   * `http://localhost` as the conventional placeholder. Used by the local
   * gateway path where chat.tsx talks to `~/.anima/agents/<id>/gateway.sock`.
   */
  unixSocketPath?: string
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
  /** v0.21.12: per-listener state. */
  listeners?: Record<string, 'active' | 'disabled' | 'failed'>
  /** v0.21.13: current permission mode (used by TUI thin client to seed statusline). */
  permsMode?: 'off' | 'prompt' | 'strict'
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
  kind: GatewayEventKind
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
    const baseFetch = opts.fetchImpl ?? globalThis.fetch
    if (opts.unixSocketPath) {
      const sock = opts.unixSocketPath
      // Bun's fetch supports `{unix: '/path'}` to route over a unix socket.
      // The URL's host portion is ignored once unix is set; we still pass
      // the full URL so Bun can parse the path component.
      this.#fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const merged = { ...(init ?? {}), unix: sock } as RequestInit & { unix: string }
        return baseFetch(url, merged as RequestInit)
      }) as typeof fetch
    } else {
      this.#fetch = baseFetch
    }
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
    // /sync uploads the full activity log + memory tree to 0G Storage and
    // anchors via one updateSlots tx. For large activity logs (multi-MB)
    // the upload can take minutes per segment. Bun's default fetch timeout
    // is 5 min, which was tripping on real-size logs. Bump to 15 min — the
    // gateway side never blocks indefinitely (0G SDK retries with backoff),
    // so a long client wait is the right ceiling.
    const r = await this.#fetch(`${this.endpoint}/sync`, {
      method: 'POST',
      signal: AbortSignal.timeout(15 * 60 * 1000),
    })
    if (!r.ok) throw new Error(`sync failed (${r.status})`)
    return (await r.json()) as { tx?: string; slots: string[] }
  }

  /**
   * v0.21.9: live-fire the AutoTopupManager to skip the 5-min poll wait.
   * Signs `adminTickHash('autotopup-tick', ts, sandboxId)` over EIP-191 so
   * the sandbox endpoint accepts it without trustLocal. Returns the tick
   * result (`{ ok: true }` or `{ ok: false, reason }`).
   */
  async triggerAutoTopupTick(): Promise<{ ok: boolean; reason?: string }> {
    const ts = Date.now()
    const hash = adminTickHash({ action: 'autotopup-tick', ts, sandboxId: this.sandboxId })
    const signature = await this.operator.signMessage({ message: { raw: hash } })
    const r = await this.#fetch(`${this.endpoint}/admin/autotopup/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts, signature }),
    })
    if (r.status === 401) {
      const detail = (await r.json().catch(() => null)) as { reason?: string } | null
      throw new Error(`autotopup-tick auth failed: ${detail?.reason ?? '401'}`)
    }
    if (r.status === 501) {
      throw new Error('autotopup-tick not supported (runtime missing triggerTopupTick)')
    }
    return (await r.json()) as { ok: boolean; reason?: string }
  }

  /**
   * v0.23.0: ship the operator-scoped PROFILE AES key into the sandbox. Same
   * EIP-191 auth as `triggerAutoTopupTick` but with action='profile-key'.
   * The 32-byte key is sent in the body — sandbox endpoints are operator-only
   * via network policy.
   */
  async setProfileKey(
    profileScopeKeyHex: `0x${string}`,
  ): Promise<{ ok: boolean; reason?: string }> {
    const ts = Date.now()
    const hash = adminTickHash({ action: 'profile-key', ts, sandboxId: this.sandboxId })
    const signature = await this.operator.signMessage({ message: { raw: hash } })
    const r = await this.#fetch(`${this.endpoint}/admin/profile-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts, signature, profileScopeKeyHex }),
    })
    if (r.status === 401) {
      const detail = (await r.json().catch(() => null)) as { reason?: string } | null
      throw new Error(`profile-key auth failed: ${detail?.reason ?? '401'}`)
    }
    if (r.status === 501) {
      throw new Error('profile-key not supported (runtime missing setProfileKey)')
    }
    return (await r.json()) as { ok: boolean; reason?: string }
  }

  /**
   * v0.24.4: forward an operator pair-mode approval to the sandbox so the
   * container's pairing dir gets the approved user. Same EIP-191 auth as
   * `triggerAutoTopupTick` / `setProfileKey` but with action='pairing-approve'.
   * Returns the result shape from `BuiltRuntime.approvePairing` so the
   * `anima pairing approve` command can print user details on success or
   * a clean error on locked-out / unknown-code.
   */
  async approvePairing(
    platform: string,
    code: string,
  ): Promise<{ ok: boolean; userId?: string; userName?: string; reason?: string }> {
    const ts = Date.now()
    const hash = adminTickHash({ action: 'pairing-approve', ts, sandboxId: this.sandboxId })
    const signature = await this.operator.signMessage({ message: { raw: hash } })
    const r = await this.#fetch(`${this.endpoint}/admin/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform, code, ts, signature }),
    })
    if (r.status === 401) {
      const detail = (await r.json().catch(() => null)) as { reason?: string } | null
      throw new Error(`pairing-approve auth failed: ${detail?.reason ?? '401'}`)
    }
    if (r.status === 501) {
      throw new Error('pairing-approve not supported (runtime missing approvePairing)')
    }
    if (r.status === 400) {
      const detail = (await r.json().catch(() => null)) as {
        error?: string
        reason?: string
      } | null
      throw new Error(
        `pairing-approve bad-request: ${detail?.error ?? '400'}${detail?.reason ? ` (${detail.reason})` : ''}`,
      )
    }
    if (r.status === 409) {
      throw new Error('pairing-approve gateway not Ready')
    }
    return (await r.json()) as {
      ok: boolean
      userId?: string
      userName?: string
      reason?: string
    }
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
    opts: {
      signal?: AbortSignal
      sinceSeq?: number
      clientKind?: 'tui' | 'dashboard' | 'other'
    } = {},
  ): AsyncGenerator<ParsedSseEvent> {
    let lastSeq = opts.sinceSeq
    const signal = opts.signal
    // v0.24.14: tag subscriber kind so the daemon's TG forward gate can
    // distinguish a live operator TUI from passive web dashboards.
    // Default `other` keeps back-compat for callers that don't set it.
    const clientKind = opts.clientKind ?? 'other'
    while (true) {
      if (signal?.aborted) return
      const headers: Record<string, string> = { accept: 'text/event-stream' }
      if (typeof lastSeq === 'number') headers['last-event-id'] = String(lastSeq)
      let res: Response
      try {
        res = await this.#fetch(`${this.endpoint}/events?client=${clientKind}`, { headers, signal })
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
  let kind: GatewayEventKind | null = null
  let dataLine = ''
  for (const rawLine of chunk.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('id: ')) {
      const n = Number.parseInt(line.slice(4), 10)
      if (Number.isFinite(n)) id = n
    } else if (line.startsWith('event: ')) {
      kind = line.slice(7) as GatewayEventKind
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
