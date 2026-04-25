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

export interface BrainInferInput {
  /** The event that woke the brain. */
  event: AnimaEvent
  /** Optional multi-turn context beyond the event payload. */
  history?: BrainMessage[]
  /** Optional tool allowlist override (defaults to all registered tools). */
  toolWhitelist?: string[]
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
