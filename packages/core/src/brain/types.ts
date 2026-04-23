import type { AnimaEvent } from '../events/types'
import type { ToolCall, ToolSchema } from '../tools/types'

export interface BrainMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
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
