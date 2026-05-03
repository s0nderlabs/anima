/**
 * Harness event hub: in-memory broadcast bus that the HTTP /events SSE endpoint
 * subscribes to. Runtime adapters publish; HTTP server forwards to clients.
 */

export type GatewayEventKind =
  | 'tool-call-start'
  | 'tool-call-end'
  | 'turn-start'
  | 'turn-end'
  | 'sync-flush'
  | 'approval-needed'
  | 'approval-resolved'
  | 'approval-expired'
  | 'listener-event'
  | 'log'
  | 'state-change'

export interface GatewayEvent {
  /** Monotonic per-hub id used for SSE last-event-id reconnects. */
  seq: number
  kind: GatewayEventKind
  ts: number
  data: unknown
}

export type Subscriber = (event: GatewayEvent) => void

export class EventHub {
  #seq = 0
  #subs = new Set<Subscriber>()
  #buffer: GatewayEvent[] = []
  #bufferLimit: number

  constructor(opts: { bufferLimit?: number } = {}) {
    this.#bufferLimit = opts.bufferLimit ?? 256
  }

  publish(kind: GatewayEventKind, data: unknown): GatewayEvent {
    this.#seq += 1
    const event: GatewayEvent = { seq: this.#seq, kind, ts: Date.now(), data }
    this.#buffer.push(event)
    if (this.#buffer.length > this.#bufferLimit) this.#buffer.shift()
    for (const sub of this.#subs) {
      try {
        sub(event)
      } catch {
        // never let one slow subscriber block the bus
      }
    }
    return event
  }

  /** Subscribe; returns unsubscribe fn. Optionally replay since last-event-id. */
  subscribe(sub: Subscriber, sinceSeq?: number): () => void {
    if (typeof sinceSeq === 'number') {
      for (const e of this.#buffer) {
        if (e.seq > sinceSeq) sub(e)
      }
    }
    this.#subs.add(sub)
    return () => {
      this.#subs.delete(sub)
    }
  }

  size(): number {
    return this.#subs.size
  }

  lastSeq(): number {
    return this.#seq
  }

  /** Drain buffered events; used in tests + graceful shutdown drains. */
  buffer(): GatewayEvent[] {
    return [...this.#buffer]
  }
}
