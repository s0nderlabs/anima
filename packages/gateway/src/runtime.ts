import type { Address, Hex } from 'viem'
import type { EventHub } from './events'

/**
 * Anima runtime config carried in the /bootstrap/provision payload. Subset of
 * the operator's anima.config that the harness needs to start. Operator
 * encrypts agent privkey + signs (envelope hash + this config); harness uses
 * the config to construct OGComputeBrain, MemorySyncManager, plugin set, etc.
 */
export interface RuntimeConfig {
  network: '0g-mainnet' | '0g-testnet'
  brain: {
    provider: Address
    model: string
    /** v0.20.0: max output tokens per turn (default 4096). */
    maxOutputTokens?: number
    /** v0.20.0: model context window for compaction trigger (default 1_000_000). */
    contextWindow?: number
    /** v0.20.0: compaction tuning. Set to null to disable. */
    compaction?: { threshold?: number; keepRecent?: number } | null
    /** v0.20.0: persist channel histories under `<agentDir>/conversations/`. Default true. */
    persistConversations?: boolean
  }
  identity: {
    iNFT: { contract: Address; tokenId: string }
    agent: Address
  }
  /** Plugin names to load (mirrors the local config). */
  plugins?: string[]
  /** Optional tool toggles ("fs.*": false). */
  tools?: Record<string, boolean>
  /** Optional permission mode. Sandbox default is 'yolo' for autonomous demo. */
  permissions?: 'off' | 'prompt' | 'strict' | 'yolo'
  /** Optional system-prompt append from the operator. */
  promptAppend?: string
  /**
   * Optional .0g subname (e.g. "specter" for `specter.anima.0g`). Used by the
   * telegram pairing greeting to address the agent by its registered name
   * instead of the hex-slug fallback. Sourced from `config.subname` in the
   * loaded anima.config.ts.
   */
  subname?: string | null
}

export interface ChatTurnInput {
  message: string
  ts: number
  /** Operator EIP-191 sig over `chatMessageHash(message, ts, sandboxId)`. */
  signature: Hex
  /** For replay defense: address that the harness verifies sig against. Always operatorAddress. */
  operatorAddress: Address
}

export interface ChatTurnResult {
  response: string
  toolCalls: Array<{ name: string; ok: boolean; durationMs: number }>
  durationMs: number
  syncTx?: string
}

/**
 * Runtime adapter that the harness server delegates to. Real impl wires
 * OGComputeBrain + MemorySyncManager + plugin set. Stub impl in
 * `stub-runtime.ts` is for HTTP-bridge testing without burning compute.
 */
export interface RuntimeAdapter {
  start(opts: {
    agentPrivkey: Hex
    config: RuntimeConfig
    events: EventHub
    secrets?: import('./secrets').GatewaySecrets
  }): Promise<void>
  runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult>
  flushSync(): Promise<{ tx?: string; slots: string[] }>
  ready(): boolean
  stop(): Promise<void>
}
