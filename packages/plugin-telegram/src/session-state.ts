// Active-session tracker for telegram turns.
//
// Mirrors hermes base.py:1417-1488. The synchronous mark-active BEFORE async
// dispatch is the load-bearing detail: without it, two messages in the same
// event-loop tick can both pass the active-check and both spawn brain turns.
//
// Bypass commands (verbatim from hermes base.py:1430): /approve, /deny,
// /status, /stop, /new, /reset, /background, /restart. These are dispatched
// inline (skipping the active-session guard) so the operator can interrupt
// or steer a turn that's already mid-flight from their phone.

export const BYPASS_COMMANDS = [
  '/stop',
  '/new',
  '/reset',
  '/status',
  '/approve',
  '/deny',
  '/background',
  '/restart',
] as const

export type BypassCommand = (typeof BYPASS_COMMANDS)[number]

/**
 * Detect a bypass command at the start of an inbound message. Returns the
 * canonical lowercase command if matched, else null. Args after the command
 * (e.g. `/stop please`) are ignored — only the leading slash-token matters.
 */
export function parseBypassCommand(text: string): BypassCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const head = trimmed.split(/\s+/)[0]?.toLowerCase()
  if (!head) return null
  if ((BYPASS_COMMANDS as readonly string[]).includes(head)) {
    return head as BypassCommand
  }
  return null
}

export interface ActiveSession {
  abortCtrl: AbortController | null
  startedAt: number
}

/**
 * Per-session-key state machine. `markActive` MUST be called synchronously
 * BEFORE any async dispatch (the race-window-closing detail). `markIdle`
 * fires from the dispatch's `finally`. `setPending` queues an interrupt
 * payload; the dispatcher reads it on the next iteration.
 */
export class ActiveSessionTracker {
  readonly #sessions = new Map<string, ActiveSession>()
  readonly #pending = new Map<string, unknown>()

  isActive(key: string): boolean {
    return this.#sessions.has(key)
  }

  markActive(key: string, abortCtrl: AbortController | null = null): void {
    this.#sessions.set(key, { abortCtrl, startedAt: Date.now() })
  }

  markIdle(key: string): void {
    this.#sessions.delete(key)
  }

  getAbortController(key: string): AbortController | null {
    return this.#sessions.get(key)?.abortCtrl ?? null
  }

  /** Called by `/stop` bypass: aborts the active turn for `key` if any. */
  abortActive(key: string): boolean {
    const session = this.#sessions.get(key)
    if (!session?.abortCtrl) return false
    session.abortCtrl.abort()
    return true
  }

  setPending(key: string, event: unknown): void {
    this.#pending.set(key, event)
  }

  takePending(key: string): unknown | undefined {
    const v = this.#pending.get(key)
    this.#pending.delete(key)
    return v
  }

  activeKeys(): string[] {
    return Array.from(this.#sessions.keys())
  }
}
