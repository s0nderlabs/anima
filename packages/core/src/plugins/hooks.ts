import type { ToolCall, ToolResult } from '../tools/types'

/**
 * Lifecycle hook surface. Plugins register handlers via `ctx.addHook(name, fn)`.
 * Hooks run in registration order; pre-* hooks may return a replacement
 * payload to mutate the input, while post-* hooks observe only.
 *
 * Phase 9.0 wires `pre_tool_call` + `post_tool_call` into the chat loop.
 * The other 8 names exist as no-op stubs so plugins can target them now and
 * future phases (LLM call, session lifecycle) can light them up without
 * breaking the contract.
 */
export type HookName =
  | 'pre_tool_call'
  | 'post_tool_call'
  | 'pre_llm_call'
  | 'post_llm_call'
  | 'pre_api_request'
  | 'post_api_request'
  | 'on_session_start'
  | 'on_session_end'
  | 'on_session_finalize'
  | 'on_session_reset'

export interface PreToolCallContext {
  call: ToolCall
}

export interface PreToolCallResult {
  /** Replacement call (e.g. permission injection edits args). undefined = no change. */
  call?: ToolCall
  /** If set, short-circuit dispatch with this result. */
  short?: ToolResult
}

export interface PostToolCallContext {
  call: ToolCall
  result: ToolResult
}

export type HookHandler<TIn, TOut = void> = (
  ctx: TIn,
) => Promise<TOut | undefined> | TOut | undefined

export class HookBus {
  private readonly handlers = new Map<HookName, HookHandler<unknown, unknown>[]>()

  add<TIn = unknown, TOut = void>(name: HookName, fn: HookHandler<TIn, TOut>): void {
    const list = this.handlers.get(name) ?? []
    list.push(fn as HookHandler<unknown, unknown>)
    this.handlers.set(name, list)
  }

  /**
   * Run pre-tool-call hooks in order. Each handler may return a replacement
   * call or a short-circuit result. The first short-circuit wins. Returns the
   * effective call + optional short-circuit.
   */
  async runPreToolCall(input: PreToolCallContext): Promise<PreToolCallResult> {
    let current: ToolCall = input.call
    const fns = this.handlers.get('pre_tool_call') ?? []
    for (const fn of fns) {
      const out = (await fn({ call: current })) as PreToolCallResult | undefined
      if (!out) continue
      if (out.short) return { short: out.short, call: current }
      if (out.call) current = out.call
    }
    return { call: current }
  }

  async runPostToolCall(input: PostToolCallContext): Promise<void> {
    const fns = this.handlers.get('post_tool_call') ?? []
    for (const fn of fns) {
      try {
        await fn(input)
      } catch {
        // Post hooks must never break the chat loop.
      }
    }
  }
}
