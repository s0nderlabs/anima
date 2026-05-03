/** Sources that can enqueue events into the runtime. */
export type EventSource =
  | 'stdin'
  | 'cron'
  | 'webhook'
  | 'a2a'
  | 'marketplace'
  | 'chain'
  | 'internal'
  | 'telegram'

export interface EventPayload {
  /** Short human-readable label for logs/status. */
  label: string
  /** Arbitrary structured data. Listener-specific shape. */
  data: unknown
  /** Any peer address (ECIES pubkey or .0g name) that originated this event. */
  peer?: string
  /** Per-listener hint about which memory topics are relevant for this event. */
  memoryHint?: string[]
}

export interface AnimaEvent {
  id: string
  source: EventSource
  payload: EventPayload
  ts: number
}
