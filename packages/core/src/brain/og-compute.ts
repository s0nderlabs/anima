/**
 * 0G Compute-backed brain. Upstream `@0glabs/0g-serving-broker` requires an
 * ethers Wallet/Signer — this file is the ONLY place in anima where ethers
 * is imported. Callers pass a raw privkey hex + RPC URL; the module builds
 * the ethers Wallet internally so the rest of the codebase can remain
 * viem-first.
 */
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker'
import { JsonRpcProvider, Wallet } from 'ethers'
import type { ToolSchema } from '../tools/types'
import {
  type CompactionOpts,
  DEFAULT_COMPACTION_OPTS,
  SUMMARY_SYSTEM_PROMPT,
  compactHistory,
  estimateTokens,
  shouldCompact,
} from './compaction'
import { type FrozenPrefix, renderFrozenPrefix, renderUserContext } from './frozen-prefix'
import type { HistoryPersist } from './history-persist'
import { sanitizeDashes } from './sanitize'
import type { Brain, BrainInferInput, BrainMessage, BrainTurn } from './types'

type Broker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>

/** Channel key used when none is specified — preserves legacy single-history behavior. */
export const DEFAULT_CHANNEL_KEY = 'default'

/** Default cap on the assistant output tokens per turn. Bumped from 1024 in v0.20.0. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096

export interface OGComputeBrainOpts {
  privkeyHex: `0x${string}`
  rpcUrl: string
  providerAddress: string
  tools: ToolSchema[]
  prefix: FrozenPrefix
  /**
   * Seed history for the legacy single-history (`'default'`) channel.
   * Backward-compat: prior callers passed this as the entire conversation.
   * In v0.20.0+, prefer per-channel APIs (`setChannelHistory`).
   */
  history?: BrainMessage[]
  /** Default 4096 (was 1024 prior to v0.20.0). */
  maxOutputTokens?: number
  /**
   * Pre-flight auto-compaction config. Omit to use {@link DEFAULT_COMPACTION_OPTS}.
   * Pass `null` to disable compaction entirely.
   */
  compaction?: CompactionOpts | null
  /**
   * Optional persistence handle. When set, channel histories are seeded from
   * disk during {@link OGComputeBrain.init} and every committed turn is
   * appended via {@link HistoryPersist.appendTurn}.
   */
  persist?: HistoryPersist
  onToolCall?: (call: { id: string; name: string; args: unknown }) => Promise<BrainMessage>
}

export interface ListedService {
  provider: string
  url?: string
  endpoint?: string
  model: string
  serviceType?: string
  inputPrice?: bigint
  outputPrice?: bigint
  verifiability?: string
  [k: string]: unknown
}

export class OGComputeBrain implements Brain {
  private broker: Broker | null = null
  private endpoint: string | null = null
  private model: string | null = null
  private readonly histories = new Map<string, BrainMessage[]>()
  private readonly lastUsage = new Map<string, BrainTurn['usage']>()
  private readonly wallet: Wallet
  private readonly renderedPrefix: string
  private userContextText: string | null
  private persistHydrated = false

  constructor(private readonly opts: OGComputeBrainOpts) {
    if (opts.history && opts.history.length > 0) {
      this.histories.set(DEFAULT_CHANNEL_KEY, [...opts.history])
    }
    const provider = new JsonRpcProvider(opts.rpcUrl)
    this.wallet = new Wallet(opts.privkeyHex, provider)
    this.renderedPrefix = renderFrozenPrefix(opts.prefix)
    this.userContextText = renderUserContext(opts.prefix)
  }

  /**
   * v0.21.0: expose the lazily-initialized broker.ledger so AutoTopupManager
   * can read the provider envelope balance and call deposit/transfer using
   * the same wallet binding as the brain. Returns null until init() runs.
   */
  getLedger(): Broker['ledger'] | null {
    return this.broker?.ledger ?? null
  }

  /**
   * Refresh the per-turn user-context payload from the latest local state.
   * Called by the chat loop right before every `infer()` so MEMORY.md updates
   * land in the next turn without rebuilding the system prompt (preserves
   * prefix cache hits).
   */
  refreshUserContext(prefix: FrozenPrefix): void {
    this.userContextText = renderUserContext(prefix)
  }

  async init(): Promise<void> {
    if (this.broker) return
    // biome-ignore lint/suspicious/noExplicitAny: broker signer shape mismatch is upstream
    this.broker = await createZGComputeNetworkBroker(this.wallet as any)
    const meta = await this.broker.inference.getServiceMetadata(this.opts.providerAddress)
    this.endpoint = meta.endpoint
    this.model = meta.model
    try {
      await this.broker.inference.acknowledgeProviderSigner(this.opts.providerAddress)
    } catch {
      // Already acknowledged — broker throws on repeat. Safe to ignore.
    }
    await this.hydrateFromPersist()
  }

  private async hydrateFromPersist(): Promise<void> {
    if (this.persistHydrated || !this.opts.persist) return
    this.persistHydrated = true
    try {
      const loaded = await this.opts.persist.loadAll()
      for (const [key, history] of loaded) {
        // Don't clobber a constructor-seeded history if the same channel was
        // pre-populated. This preserves legacy `opts.history` for the default
        // channel.
        if (this.histories.has(key) && (this.histories.get(key)?.length ?? 0) > 0) continue
        this.histories.set(key, [...history])
      }
    } catch {
      // Persist load failures must never block brain startup — chat works
      // in-memory only and persist resumes on next clean run.
    }
  }

  /** Snapshot of a channel's current history (read-only, defensive copy). */
  getChannelHistory(channelKey: string = DEFAULT_CHANNEL_KEY): readonly BrainMessage[] {
    return [...(this.histories.get(channelKey) ?? [])]
  }

  /** Wholesale replace a channel's history. Used by tests and by persist hydration. */
  setChannelHistory(channelKey: string, history: BrainMessage[]): void {
    this.histories.set(channelKey, [...history])
  }

  /** Clear a single channel. Best-effort persist clear. */
  async clearChannel(channelKey: string = DEFAULT_CHANNEL_KEY): Promise<void> {
    this.histories.set(channelKey, [])
    this.lastUsage.delete(channelKey)
    if (this.opts.persist) {
      try {
        await this.opts.persist.clearChannel(channelKey)
      } catch {
        // best-effort
      }
    }
  }

  /** Distinct channel keys with non-empty history. */
  listChannels(): string[] {
    const out: string[] = []
    for (const [k, v] of this.histories) {
      if (v.length > 0) out.push(k)
    }
    return out
  }

  private getOrCreateHistory(channelKey: string): BrainMessage[] {
    let h = this.histories.get(channelKey)
    if (!h) {
      h = []
      this.histories.set(channelKey, h)
    }
    return h
  }

  /** Fetch live catalog without requiring a specific provider to be pre-set. */
  static async listServicesFor(args: {
    privkeyHex: `0x${string}`
    rpcUrl: string
  }): Promise<ListedService[]> {
    const provider = new JsonRpcProvider(args.rpcUrl)
    const wallet = new Wallet(args.privkeyHex, provider)
    // biome-ignore lint/suspicious/noExplicitAny: broker signer shape mismatch is upstream
    const broker = await createZGComputeNetworkBroker(wallet as any)
    return (await broker.inference.listService()) as unknown as ListedService[]
  }

  async listServices(): Promise<ListedService[]> {
    if (!this.broker) await this.init()
    const services = (await this.broker!.inference.listService()) as unknown as ListedService[]
    return services
  }

  /** Live ledger balance in 0G (the prepaid compute credit). null on failure. */
  async getLedgerBalance(): Promise<number | null> {
    if (!this.broker) await this.init()
    try {
      const ledger = await this.broker!.ledger.getLedger()
      // broker returns BigNumber-like; convert via formatEther fallback
      const totalRaw = (ledger as { totalBalance?: bigint | string }).totalBalance
      const lockedRaw = (ledger as { locked?: bigint | string }).locked
      if (totalRaw == null) return null
      const toBigInt = (v: bigint | string): bigint =>
        typeof v === 'bigint' ? v : BigInt(v.toString())
      const total = toBigInt(totalRaw)
      const locked = lockedRaw != null ? toBigInt(lockedRaw) : 0n
      const available = total - locked
      // available is in wei (18 decimals)
      return Number(available) / 1e18
    } catch {
      return null
    }
  }

  async infer(input: BrainInferInput): Promise<BrainTurn> {
    if (!this.broker) await this.init()
    const signal = input.signal
    if (signal?.aborted) {
      throw new DOMException('aborted before infer started', 'AbortError')
    }
    const channelKey = input.channelKey ?? DEFAULT_CHANNEL_KEY
    await this.maybeCompact(channelKey, input)

    const history = this.getOrCreateHistory(channelKey)
    const userText = normalizeUserContent(input)
    const messages: BrainMessage[] = [{ role: 'system', content: this.renderedPrefix }, ...history]
    // Per-turn user-context (MEMORY.md, etc.) injected just before the live
    // user message. Treated as a separate user turn so MEMORY.md churn doesn't
    // invalidate the system-prompt cache.
    if (this.userContextText) {
      messages.push({ role: 'user', content: this.userContextText })
    }
    messages.push({ role: 'user', content: userText })

    let turnResult: BrainTurn | null = null
    // No round-trip cap: the brain exits naturally when it returns a
    // content-only response (no tool_calls). Capping here truncated multi-step
    // browser drives before the final answer.
    let recoveredFromSafetyBlock = false
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('aborted between round-trips', 'AbortError')
      }
      const resp = await this.callCompletion(messages, signal)
      turnResult = resp

      if (!resp.toolCalls.length) {
        // qwen3.6-plus on the 0G broker sometimes returns its safety-filter
        // reject as a plain assistant turn (no tool_calls). The string looks
        // like: "An error occurred while generating a tool call: Unauthorized:
        // <name> is a blocked tool." That happens when the model generates a
        // tool name that doesn't match any registered tool (typically the
        // bare prefix of a dotted name, e.g. "browser" instead of
        // "browser.snapshot"). Auto-recover once: inject a corrective user
        // message naming the valid tools, then continue the loop so the brain
        // can re-issue with the correct dotted name.
        const blockedName = detectBlockedToolError(resp.content ?? '')
        if (blockedName && !recoveredFromSafetyBlock) {
          recoveredFromSafetyBlock = true
          const validNames = this.opts.tools
            .map(t => (t as { name?: string }).name ?? '')
            .filter(n => n.startsWith(`${blockedName}.`) || n.startsWith(`${blockedName}_`))
            .slice(0, 12)
          const hint =
            validNames.length > 0
              ? `Your last tool call used the bare name "${blockedName}", which is not a registered tool. Use the full name with subname (one of: ${validNames.join(', ')}). Retry now.`
              : `Your last tool call used the bare name "${blockedName}", which is not a registered tool. Use the full namespaced name (e.g., something.action). Retry now.`
          messages.push({ role: 'user', content: hint })
          continue
        }
        messages.push({ role: 'assistant', content: resp.content ?? '' })
        break
      }

      messages.push({
        role: 'assistant',
        content: resp.content ?? '',
        toolCalls: resp.toolCalls,
      })

      for (const call of resp.toolCalls) {
        if (signal?.aborted) {
          throw new DOMException('aborted between tool calls', 'AbortError')
        }
        // Qwen3.6 occasionally emits a tool_call with empty `function.name`
        // or truncated `function.arguments` JSON. Don't dispatch — inject a
        // corrective tool-result so the brain can re-issue cleanly.
        const isMalformed =
          !call.name ||
          (typeof call.args === 'string' &&
            call.args !== '' &&
            !looksLikeValidJsonString(call.args))
        if (isMalformed) {
          const toolLabel = call.name || MALFORMED_TOOL_LABEL
          if (input.onToolEvent) {
            try {
              input.onToolEvent({
                kind: 'start',
                tool: toolLabel,
                callId: call.id,
                argsPreview: previewToolArgs(call.args),
              })
              input.onToolEvent({ kind: 'end', tool: toolLabel, callId: call.id, ok: false })
            } catch {
              /* swallow */
            }
          }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({
              error:
                'Tool call envelope was malformed (empty name or truncated arguments). Re-emit with a complete tool name and a parseable JSON args object.',
            }),
          })
          continue
        }
        if (!this.opts.onToolCall) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ error: 'Tool handler not wired' }),
          })
          continue
        }
        if (input.onToolEvent) {
          try {
            input.onToolEvent({
              kind: 'start',
              tool: call.name,
              callId: call.id,
              argsPreview: previewToolArgs(call.args),
            })
          } catch {
            /* observer errors must never block tool execution */
          }
        }
        const toolMsg = await this.opts.onToolCall(call)
        if (input.onToolEvent) {
          try {
            input.onToolEvent({
              kind: 'end',
              tool: call.name,
              callId: call.id,
              ok: inferToolOk(toolMsg.content ?? ''),
            })
          } catch {
            /* swallow */
          }
        }
        messages.push({ ...toolMsg, toolCallId: call.id })
      }
    }

    const finalAssistant = findLastAssistantContent(messages)
    const userMsg: BrainMessage = { role: 'user', content: userText }
    const assistantMsg: BrainMessage = { role: 'assistant', content: finalAssistant }
    history.push(userMsg)
    history.push(assistantMsg)

    if (turnResult?.usage) this.lastUsage.set(channelKey, turnResult.usage)

    if (this.opts.persist) {
      try {
        await this.opts.persist.appendTurn(channelKey, userMsg, assistantMsg)
      } catch {
        // Persist failure is non-fatal for the live turn.
      }
    }

    // v0.22.1: backstop em-dash/en-dash hard rule. Frozen-prefix forbids
    // these characters but qwen3.6-plus occasionally slips. Sanitize at the
    // single brain-output point so every surface (TUI/TG/A2A/market) gets
    // clean text without per-surface duplication.
    if (turnResult?.content) {
      turnResult.content = sanitizeDashes(turnResult.content)
    }
    return turnResult ?? { content: null, toolCalls: [] }
  }

  /**
   * Pre-flight compaction check. When threshold is breached, summarize older
   * messages (everything before the last `keepRecent * 2`) via a sub-call
   * with no tools and replace the channel history. Caller's `onCompactionEvent`
   * fires AFTER successful fold.
   */
  private async maybeCompact(channelKey: string, input: BrainInferInput): Promise<void> {
    if (this.opts.compaction === null) return
    const cfg = this.opts.compaction ?? DEFAULT_COMPACTION_OPTS
    const history = this.histories.get(channelKey)
    if (!history || history.length === 0) return
    const lastUsage = this.lastUsage.get(channelKey)
    const trigger = shouldCompact(history, lastUsage?.promptTokens ?? null, cfg)
    if (trigger == null) return
    let compacted: BrainMessage[]
    try {
      compacted = await compactHistory(history, cfg, async older => this.summarizeOlder(older))
    } catch {
      // Compaction is best-effort; failure means we proceed with the original
      // history this turn and try again next time.
      return
    }
    if (compacted.length >= history.length) return // nothing folded
    this.histories.set(channelKey, compacted)
    this.lastUsage.delete(channelKey) // estimate-based until next usage lands
    if (this.opts.persist) {
      try {
        await this.opts.persist.rewriteChannel(channelKey, compacted)
      } catch {
        // best-effort; rehydration on restart will reflect the on-disk state
      }
    }
    if (input.onCompactionEvent) {
      try {
        input.onCompactionEvent({
          channelKey,
          from: history.length,
          to: compacted.length,
          promptTokens: trigger,
        })
      } catch {
        /* observer errors swallowed */
      }
    }
  }

  /**
   * Summarize the older portion of a channel's history via a fresh sub-call
   * to the same broker, with no tools, lower max_tokens, and the
   * compaction-specific system prompt. This is the only place the brain
   * recursively calls its own provider for housekeeping.
   */
  private async summarizeOlder(older: readonly BrainMessage[]): Promise<string> {
    if (!this.broker || !this.endpoint || !this.model) {
      throw new Error('Brain not initialized; call init() first.')
    }
    // Flatten tool-call metadata into a readable transcript. The sub-call
    // doesn't need full structure — just enough text to summarize accurately.
    const flat = older
      .map(m => {
        const tag = m.role.toUpperCase()
        if (m.toolCalls && m.toolCalls.length > 0) {
          const calls = m.toolCalls
            .map(
              tc =>
                `${tc.name}(${typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {})})`,
            )
            .join(' | ')
          return `${tag}: ${m.content || ''}\n[TOOL_CALLS] ${calls}`
        }
        return `${tag}: ${m.content || ''}`
      })
      .join('\n\n')
    const headers = await this.broker.inference.getRequestHeaders(this.opts.providerAddress, flat)
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: flat },
      ],
      max_tokens: 1024,
    }
    const resp = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      throw new Error(`Compaction summarize HTTP ${resp.status}`)
    }
    const json = (await resp.json()) as {
      choices: Array<{ message: { content?: string | null } }>
    }
    return (json.choices[0]?.message.content ?? '').trim()
  }

  private async callCompletion(messages: BrainMessage[], signal?: AbortSignal): Promise<BrainTurn> {
    if (!this.broker || !this.endpoint || !this.model) {
      throw new Error('Brain not initialized; call init() first.')
    }
    const last = messages.at(-1)!
    const headers = await this.broker.inference.getRequestHeaders(
      this.opts.providerAddress,
      typeof last.content === 'string' ? last.content : JSON.stringify(last.content),
    )
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
              },
            })),
          }
        }
        return { role: m.role, content: m.content }
      }),
      max_tokens: this.opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    }
    // 0G's broker (DashScope) rejects an empty tools array (`[] is too short`).
    // Only include the fields when at least one tool is in the schema list.
    if (this.opts.tools.length > 0) {
      body.tools = this.opts.tools
      body.tool_choice = 'auto'
    }
    const resp = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    })
    if (!resp.ok) {
      const body = await resp.text()
      // Translate the 0G provider's "insufficient balance" HTTP 400 into a
      // typed error so dispatchers (TUI + TG) can render an actionable
      // message ("anima topup --compute N") instead of the raw HTTP body.
      // Pattern matches the message format from
      // `feedback-compute-ledger-total-vs-provider.md`.
      const ledgerErr = parseLedgerInsufficientError(body, this.opts.providerAddress)
      if (ledgerErr) throw ledgerErr
      throw new Error(`Brain HTTP ${resp.status}: ${body}`)
    }
    const json = (await resp.json()) as {
      choices: Array<{
        finish_reason?: string
        message: {
          content?: string | null
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
          }>
          reasoning_content?: string
        }
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    const choice = json.choices[0]!
    const msg = choice.message
    // Qwen3.6 sometimes routes the visible response into reasoning_content
    // instead of content when thinking mode doesn't transition out cleanly.
    // Fall back to stripped reasoning so the operator sees the answer.
    const rawContent = msg.content
    const reasoning = msg.reasoning_content
    const fallbackFromReasoning =
      !rawContent && reasoning && reasoning.length > 0 ? stripThinkBlocks(reasoning) : null
    return {
      content: rawContent ? rawContent : fallbackFromReasoning,
      toolCalls: (msg.tool_calls ?? []).map(tc => ({
        id: tc.id,
        name: tc.function.name,
        args: safeParseJson(tc.function.arguments),
      })),
      reasoningContent: msg.reasoning_content,
      finishReason: choice.finish_reason,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
        cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens,
      },
    }
  }
}

function normalizeUserContent(input: BrainInferInput): string {
  const d = input.event.payload.data
  if (typeof d === 'string') return d
  return JSON.stringify(d)
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Cheap probe: does this string look like complete JSON? Used to detect
 * truncated tool_call.function.arguments where Qwen's emission cut off
 * mid-token (e.g. `{"query": "browser navigate"` with no closing brace).
 */
export function looksLikeValidJsonString(raw: string): boolean {
  if (!raw || raw.length === 0) return true
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/g
const MALFORMED_TOOL_LABEL = '<malformed>'

/**
 * Strip `<think>...</think>` wrappers that Qwen3.x reasoning mode emits
 * around chain-of-thought. Used as fallback when the broker routes the
 * visible answer into reasoning_content instead of content.
 */
export function stripThinkBlocks(text: string): string {
  if (!text) return text
  return text.replace(THINK_BLOCK_RE, '').trim()
}

/**
 * Detect the 0G broker's safety-filter reject ("An error occurred while
 * generating a tool call: Unauthorized: <name> is a blocked tool.") and
 * return the blocked tool name. Returns null when the content is a normal
 * response.
 */
export function detectBlockedToolError(content: string): string | null {
  if (!content) return null
  const m = content.match(/Unauthorized:\s+(\S+)\s+is a blocked tool/)
  return m ? m[1]! : null
}

function findLastAssistantContent(messages: BrainMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'assistant') return m.content
  }
  return ''
}

/**
 * Format a compact preview of tool args for the per-turn observer. Keeps the
 * essence of "what the brain is doing" without dumping the full payload to a
 * UI surface (TG progress message especially).
 *
 * - String: pass through, truncated.
 * - Object: top-level keys joined; first scalar value preview if short.
 * - Array: count + first element preview.
 * - Other: best-effort JSON stringify.
 */
export function previewToolArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return truncatePreview(args)
  if (Array.isArray(args)) return `[${args.length}]`
  if (typeof args === 'object') {
    const o = args as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 0) return ''
    // Prefer a single short scalar field if present.
    for (const k of ['url', 'path', 'command', 'query', 'name', 'address']) {
      const v = o[k]
      if (typeof v === 'string' && v.length > 0) return truncatePreview(`${k}=${v}`)
    }
    return truncatePreview(keys.join(','))
  }
  try {
    return truncatePreview(String(args))
  } catch {
    return ''
  }
}

function truncatePreview(s: string): string {
  const max = 60
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

/**
 * Thrown when the 0G provider rejects the request with HTTP 400 because the
 * agent's compute ledger sub-account for that provider is below the minimum
 * locked balance. Caught by TUI + TG dispatchers to render a topup hint
 * instead of the raw HTTP body.
 *
 * The provider error message pattern (May 2026):
 *   "Provider proxy: handle proxied service, validate request:
 *    insufficient balance: your locked balance is X 0G, but the required
 *    minimum is Y 0G (breakdown: minimum reserve A 0G + unsettled fees
 *    B 0G + current request fee C 0G). Please add more"
 */
export class LedgerInsufficientError extends Error {
  /** Locked balance in the provider sub-account, in 0G (string for precision). */
  readonly availableOg: string
  /** Required minimum, in 0G. */
  readonly requiredOg: string
  /** required − available, in 0G. */
  readonly shortfallOg: string
  /** Provider EOA the agent's brain is configured to use. */
  readonly providerAddress: string

  constructor(opts: {
    availableOg: string
    requiredOg: string
    shortfallOg: string
    providerAddress: string
  }) {
    super(
      `Compute ledger sub-account short by ${opts.shortfallOg} 0G (provider ${opts.providerAddress.slice(0, 10)}…, locked ${opts.availableOg} of ${opts.requiredOg} required). Topup with: anima topup --compute 2`,
    )
    this.name = 'LedgerInsufficientError'
    this.availableOg = opts.availableOg
    this.requiredOg = opts.requiredOg
    this.shortfallOg = opts.shortfallOg
    this.providerAddress = opts.providerAddress
  }
}

const LEDGER_ERROR_RE =
  /insufficient balance: your locked balance is ([\d.]+)\s*0G, but the required minimum is ([\d.]+)\s*0G/i

export function parseLedgerInsufficientError(
  body: string,
  providerAddress: string,
): LedgerInsufficientError | null {
  if (!body) return null
  const m = body.match(LEDGER_ERROR_RE)
  if (!m || !m[1] || !m[2]) return null
  const available = Number.parseFloat(m[1])
  const required = Number.parseFloat(m[2])
  if (!Number.isFinite(available) || !Number.isFinite(required)) return null
  const shortfall = Math.max(0, required - available)
  return new LedgerInsufficientError({
    availableOg: m[1],
    requiredOg: m[2],
    shortfallOg: shortfall.toFixed(6),
    providerAddress,
  })
}

/**
 * Heuristic ok-detection for the per-turn observer. Tools return JSON content
 * with `{ok, error, ...}` shape; a missing `ok` AND missing `error` is
 * considered a soft success (rare).
 */
export function inferToolOk(content: string): boolean {
  if (!content) return true
  try {
    const o = JSON.parse(content) as Record<string, unknown>
    if (typeof o.ok === 'boolean') return o.ok
    if (typeof o.error === 'string' && o.error.length > 0) return false
    return true
  } catch {
    return !content.toLowerCase().includes('error')
  }
}

// Re-export estimateTokens so callers that want to measure prompt size
// without a full BrainTurn round-trip can use the same heuristic.
export { estimateTokens }
