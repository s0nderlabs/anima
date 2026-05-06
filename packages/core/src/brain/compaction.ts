/**
 * Auto-compaction: pre-flight summarize-fold of older history when the
 * running token estimate breaches a configurable fraction of the model
 * context window.
 *
 * Cost / quality model:
 *   - Compaction cost is one extra inference call (the summarize step) per
 *     fold. Default threshold 0.5 of contextWindow means a Qwen 1M session
 *     compacts ~once per 500K tokens of accumulated transcript.
 *   - Frozen prefix (system prompt + identity + persona + skills) is NEVER
 *     touched by compaction — caller-managed, designed to stay cache-warm.
 *     This module only operates on the `history` array (user/assistant pairs).
 *   - The summary is inserted as a single user-role message wrapped in
 *     `<previous-context-summary>...</previous-context-summary>` so the brain
 *     can recognize it as historical context, not a fresh request.
 */

import type { BrainMessage } from './types'

export interface CompactionOpts {
  /** Fraction of contextWindow (0-1) that triggers compaction. */
  threshold: number
  /** Model context window in tokens. */
  contextWindow: number
  /**
   * Number of recent turns to keep verbatim AFTER the summary.
   * Each "turn" is 2 messages (user + assistant), so keepRecent: 8 retains
   * the last 16 messages.
   */
  keepRecent: number
}

export const DEFAULT_COMPACTION_OPTS: CompactionOpts = {
  threshold: 0.5,
  contextWindow: 1_000_000,
  keepRecent: 8,
}

/**
 * System prompt fed to the summarizer sub-call. Tuned to extract durable
 * facts and decisions while dropping pleasantries; output is plain text with
 * no preamble so the wrapper tag is the only structure around it.
 */
export const SUMMARY_SYSTEM_PROMPT = `You are summarizing a conversation between an operator and an AI agent so the agent can keep working with context that fits in its budget.

Produce a tight, factual recap (3-8 sentences) preserving:
- Key facts the operator stated about themselves, their goals, and constraints.
- Decisions that were made and why.
- Tool outputs the agent referenced or relied on (URLs visited, balances read, files written).
- In-progress goals or tasks the agent is mid-flight on.

Drop pleasantries, repeated clarifications, verbose tool args, and redundant agent prose.

Output the summary text only. Do not add a preamble like "Here is the summary:" — start with the first fact.`

/**
 * Heuristic token estimator: ~3.5 chars per token (slightly conservative for
 * Qwen-style tokenizers on mixed content). Used as a fallback when the brain
 * has no `usage.promptTokens` from the prior turn yet.
 */
export function estimateTokens(messages: readonly BrainMessage[]): number {
  let total = 0
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : ''
    total += Math.ceil(text.length / 3.5)
    // Rough overhead for tool_calls metadata (id, name, args JSON).
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += Math.ceil((tc.name?.length ?? 0) / 3.5)
        const argStr = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {})
        total += Math.ceil(argStr.length / 3.5)
      }
    }
  }
  return total
}

/**
 * Decide whether the next infer() call should compact first.
 *
 * Three conditions must hold:
 *   1. History has more messages than `keepRecent * 2 + 4` (otherwise there's
 *      nothing meaningful to fold — keep is what we'd already keep).
 *   2. Either the prior turn's `usage.promptTokens` (canonical) or the
 *      heuristic estimate exceeds `threshold * contextWindow`.
 *
 * Returns the trigger token count (the larger of usage and estimate) for the
 * caller to log via the compaction event, or null when no compaction needed.
 */
export function shouldCompact(
  history: readonly BrainMessage[],
  lastTurnPromptTokens: number | null,
  opts: CompactionOpts,
): number | null {
  if (history.length < opts.keepRecent * 2 + 4) return null
  const estimate = estimateTokens(history)
  // We take the max of the prior turn's authoritative usage and the heuristic
  // estimate. Usage alone misses messages appended since the last turn (the
  // pending user msg), so the estimate is the conservative cap.
  const tokens = Math.max(lastTurnPromptTokens ?? 0, estimate)
  const limit = opts.threshold * opts.contextWindow
  return tokens > limit ? tokens : null
}

export type SummarizeFn = (older: readonly BrainMessage[]) => Promise<string>

/**
 * Fold older messages into a single `<previous-context-summary>` user
 * message and return the new history (summary + last `keepRecent * 2`
 * messages verbatim).
 *
 * If the history is already short enough that there are no "older" messages
 * to fold, returns the input unchanged.
 *
 * Thrown errors from `summarize` propagate — caller decides whether to skip
 * compaction this turn (best-effort) or fail the turn.
 */
export async function compactHistory(
  history: readonly BrainMessage[],
  opts: CompactionOpts,
  summarize: SummarizeFn,
): Promise<BrainMessage[]> {
  const recentCount = opts.keepRecent * 2
  if (history.length <= recentCount) return [...history]
  const recent = history.slice(-recentCount)
  const older = history.slice(0, -recentCount)
  if (older.length === 0) return [...history]
  const summary = await summarize(older)
  const wrapped = `<previous-context-summary>\n${summary.trim()}\n</previous-context-summary>`
  return [{ role: 'user', content: wrapped }, ...recent]
}
