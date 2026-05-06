import type { AnimaEvent } from '../events/types'
import type { ToolCall, ToolSchema } from '../tools/types'

export interface BrainMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Required on `tool` role: the id of the assistant tool_call this responds to. */
  toolCallId?: string
  /**
   * Required on `assistant` role messages that issued tool_calls. Without this
   * the next round-trip's `tool` message has no preceding `tool_calls` to
   * reference, and the OpenAI-compat endpoint rejects with HTTP 400
   * "messages with role 'tool' must be a response to a preceeding message
   * with 'tool_calls'".
   */
  toolCalls?: Array<{ id: string; name: string; args: unknown }>
}

/**
 * Per-tool-call lifecycle event surfaced to the dispatcher for UI rendering.
 * Distinct from the brain-construction `onToolCall` (which actually EXECUTES
 * the tool); this is fire-and-forget for "show what the agent is doing right
 * now" surfaces (TG progress message, future TUI bridge, etc.).
 *
 * Errors thrown by the observer are swallowed by the brain.
 */
export interface BrainToolEvent {
  /** 'start' fires BEFORE tool execution; 'end' fires AFTER. */
  kind: 'start' | 'end'
  /** Fully-qualified tool name, e.g. `shell.run`. */
  tool: string
  /** Tool-call id; correlates start ↔ end pair within the same turn. */
  callId: string
  /** Short stringified args preview (≤ ~80 chars). Present on 'start'. */
  argsPreview?: string
  /** Tool execution success. Heuristic from result content. Present on 'end'. */
  ok?: boolean
}

/**
 * Compaction event surfaced when the brain auto-folds older history into a
 * summary message. Subscribers (TUI primarily) use this to push a system row
 * so the operator knows the summary fired. Errors thrown by the observer are
 * swallowed by the brain.
 */
export interface BrainCompactionEvent {
  /** Channel whose history was compacted. */
  channelKey: string
  /** Number of messages BEFORE compaction (full history length). */
  from: number
  /** Number of messages AFTER compaction (summary + kept recent). */
  to: number
  /** Token estimate of the pre-compaction history. */
  promptTokens: number
}

export interface BrainInferInput {
  /** The event that woke the brain. */
  event: AnimaEvent
  /** Optional multi-turn context beyond the event payload. */
  history?: BrainMessage[]
  /** Optional tool allowlist override (defaults to all registered tools). */
  toolWhitelist?: string[]
  /**
   * Channel partition for this turn's history. Each surface keeps its own
   * conversation context: TUI/stdin is `'tui:stdin'`, Telegram DM is
   * `agent:<name>:telegram:dm:<chatId>`, A2A drains use `a2a:<peer>`,
   * marketplace uses `'marketplace'`. Missing key falls back to `'default'`.
   *
   * Backward-compatible: omitting the key keeps the legacy single-history
   * behavior under the `'default'` channel.
   */
  channelKey?: string
  /**
   * Cancel the in-flight turn. Aborts the upstream HTTP fetch (so 0G
   * Compute stops billing the round-trip immediately) and short-circuits
   * the tool-call loop. The promise rejects with a DOMException whose
   * `.name === 'AbortError'`. Caller should catch that and treat it as
   * a clean operator-driven cancel, not an error.
   */
  signal?: AbortSignal
  /**
   * Per-turn observer of tool-call lifecycle. Fired by the brain before and
   * after each tool execution. Use for UI streaming (TG progress message,
   * TUI bridge) without bothering the brain-construction onToolCall (which
   * is the actual tool executor). Errors swallowed by the brain.
   */
  onToolEvent?: (ev: BrainToolEvent) => void
  /**
   * Per-turn observer of compaction events. Fires when the pre-flight
   * threshold check triggers a summarize-fold of older messages. TUI
   * surfaces this as a system row; TG dispatchers leave it silent.
   */
  onCompactionEvent?: (ev: BrainCompactionEvent) => void
}

export interface BrainTurn {
  content: string | null
  toolCalls: ToolCall[]
  reasoningContent?: string
  finishReason?: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cachedTokens?: number
  }
}

export interface Brain {
  infer(input: BrainInferInput): Promise<BrainTurn>
  /**
   * v0.20.0: clear a channel's history. Optional so legacy non-OG brains
   * (StubBrain etc) don't have to implement it.
   */
  clearChannel?(channelKey?: string): Promise<void> | void
}

export interface BrainProvider {
  name: string
  build(opts: BrainProviderOpts): Promise<Brain>
}

export interface BrainProviderOpts {
  systemPrompt: string
  tools: ToolSchema[]
  maxTokens?: number
  maxOutputTokens?: number
}
