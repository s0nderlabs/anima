import type { Address } from 'viem'

/**
 * Sliding-window counter per non-contact sender. The listener consults this
 * BEFORE pushing a pending-request notification so a single bad actor can't
 * DoS the operator with hundreds of "X wants to chat" prompts. Contacts are
 * exempt (handled before this filter in the listener chain).
 *
 * In-memory only. Resets on process restart, which is acceptable: a fresh
 * boot gives the operator a single notification on the first inbound, then
 * the limiter takes over for follow-ups.
 */
export interface RateLimitOpts {
  /** Max events per window before drops kick in. */
  capacity: number
  /** Window length in ms. */
  windowMs: number
}

export class RateLimiter {
  private readonly capacity: number
  private readonly windowMs: number
  private readonly hits = new Map<string, number[]>()

  constructor(opts: RateLimitOpts) {
    this.capacity = opts.capacity
    this.windowMs = opts.windowMs
  }

  /**
   * Returns true if the event should be DROPPED. False = pass through.
   */
  shouldDrop(addr: Address): boolean {
    const k = addr.toLowerCase()
    const now = Date.now()
    const cutoff = now - this.windowMs
    const arr = this.hits.get(k) ?? []
    // Drop expired entries.
    let i = 0
    while (i < arr.length && arr[i]! < cutoff) i++
    const fresh = i === 0 ? arr : arr.slice(i)
    fresh.push(now)
    this.hits.set(k, fresh)
    return fresh.length > this.capacity
  }

  reset(addr?: Address): void {
    if (addr) this.hits.delete(addr.toLowerCase())
    else this.hits.clear()
  }
}
