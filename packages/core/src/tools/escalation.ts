import type { ToolCall, ToolResult } from './types'

/**
 * v0.21.2: web.fetch returns `{ blocked:true, block_reason }` when it hits a
 * Cloudflare interstitial / Google bot block / captcha / rate-limit. The brain
 * SHOULD then call browser.navigate per the v0.20.2 frozen-prefix rule, but
 * Qwen3.6 ignores conditional prose rules in long contexts: live drives showed
 * the brain ending turn with toolCalls=0, leaving the operator with "(no reply)"
 * on TG and a memory disclaimer on TUI.
 *
 * Fix: the dispatcher (chat.tsx onToolCall + build-runtime.ts onToolCall) calls
 * `runEscalation`. Both wrappers share orchestration (pre/post hooks, dispatch,
 * activity append, merge) here; only the UX side effects (state.pushRow vs
 * events.publish) are passed as callbacks. Brain sees one merged tool message.
 */

const ESCALATED_ID_PREFIX = 'auto-escalate-'

export interface FetchEscalation {
  needed: boolean
  escalatedCall?: ToolCall
  reason?: string
  url?: string
}

/**
 * Decide whether a web.fetch result warrants an automatic browser.navigate
 * retry. Only fires for `web.fetch` (gate by name); only when the result was
 * itself ok (a hard HTTP 5xx / network error is a different failure mode and
 * browser.navigate won't fix it). Refuses to escalate calls that are themselves
 * synthesized escalations, blocking any future tail-recursion regression.
 *
 * URL preference order: `result.data.final_url` (post-redirect canonical URL),
 * then `call.args.url` (original request). If neither is present we cannot
 * synthesize a browser.navigate call, so escalation is skipped.
 */
export function detectFetchEscalation(call: ToolCall, result: ToolResult): FetchEscalation {
  if (call.name !== 'web.fetch') return { needed: false }
  if (typeof call.id === 'string' && call.id.startsWith(ESCALATED_ID_PREFIX))
    return { needed: false }
  if (!result.ok) return { needed: false }
  const data = result.data as Record<string, unknown> | undefined
  if (!data || data.blocked !== true) return { needed: false }
  const finalUrl = typeof data.final_url === 'string' ? data.final_url : null
  const argUrl = extractUrlFromCallArgs(call)
  const url = finalUrl && finalUrl.length > 0 ? finalUrl : argUrl
  if (!url) return { needed: false }
  const reason = typeof data.block_reason === 'string' ? data.block_reason : 'unknown'
  return {
    needed: true,
    escalatedCall: {
      id: `${ESCALATED_ID_PREFIX}${call.id}`,
      name: 'browser.navigate',
      args: { url },
    },
    reason,
    url,
  }
}

function extractUrlFromCallArgs(call: ToolCall): string | null {
  if (!call.args || typeof call.args !== 'object') return null
  const args = call.args as Record<string, unknown>
  return typeof args.url === 'string' && args.url.length > 0 ? args.url : null
}

/**
 * Merge a blocked web.fetch result with an escalated browser.navigate result
 * into the single tool message the brain receives. Original `data.body` (the
 * bot-block markdown) is preserved alongside `data.auto_escalation` so the
 * brain has full context to call `browser.snapshot` next.
 *
 * `mergedResult.ok` reflects the ESCALATED call's success: if browser.navigate
 * also failed (no agent-browser binary, headless Chrome flake, etc.), the
 * brain sees ok:false and can degrade gracefully.
 */
export function mergeEscalationResult(
  original: ToolResult,
  escalated: ToolResult,
  escalation: FetchEscalation,
): ToolResult {
  const originalData =
    original.data && typeof original.data === 'object'
      ? (original.data as Record<string, unknown>)
      : {}
  const merged: ToolResult = {
    ok: escalated.ok,
    data: {
      ...originalData,
      auto_escalation: {
        triggered: true,
        from: 'web.fetch',
        to: 'browser.navigate',
        reason: escalation.reason ?? 'unknown',
        url: escalation.url ?? '',
        result: escalated,
      },
    },
  }
  if (!escalated.ok) {
    merged.error = `auto-escalation failed: ${escalated.error ?? 'unknown'}`
  }
  return merged
}

export interface EscalationDeps {
  /** Run pre-tool hooks (permission, sandbox bridge). Mirrors HookBus shape. */
  runPreCall: (call: ToolCall) => Promise<{ short?: ToolResult; call?: ToolCall }>
  /** Run post-tool hooks (audit, telemetry). */
  runPostCall: (call: ToolCall, result: ToolResult) => Promise<void>
  /** Dispatch the (possibly hook-replaced) call to the tool registry. */
  dispatch: (call: ToolCall) => Promise<ToolResult>
  /** Append a `kind:'tool-call'` activity entry tagged `autoEscalated:true`. */
  appendActivity: (call: ToolCall, result: ToolResult) => Promise<void>
  /** UX sink: notify the operator a follow-up call is starting. */
  onStart: (call: ToolCall) => void
  /** UX sink: notify the operator the follow-up call finished. */
  onEnd: (call: ToolCall, result: ToolResult, durationMs: number) => void
}

/**
 * Orchestrate the escalated browser.navigate dispatch on behalf of the brain
 * wrapper. Owns: UX start → pre-hook → dispatch (or short-circuit) → post-hook →
 * activity append → UX end → merge. Both `chat.tsx` and `build-runtime.ts` call
 * this so any future change (extra hook, retry policy, telemetry) lands in one
 * place instead of drifting between TUI and gateway paths.
 */
export async function runEscalation(
  escalation: FetchEscalation,
  originalResult: ToolResult,
  deps: EscalationDeps,
): Promise<ToolResult> {
  if (!escalation.needed || !escalation.escalatedCall) return originalResult
  const synthCall = escalation.escalatedCall
  const startedAt = Date.now()
  deps.onStart(synthCall)
  const pre = await deps.runPreCall(synthCall)
  const effective = pre.call ?? synthCall
  let result: ToolResult
  if (pre.short) {
    result = pre.short
  } else {
    result = await deps.dispatch(effective)
    await deps.runPostCall(effective, result)
  }
  await deps.appendActivity(effective, result)
  deps.onEnd(effective, result, Date.now() - startedAt)
  return mergeEscalationResult(originalResult, result, escalation)
}
