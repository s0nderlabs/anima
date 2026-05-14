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
    /** v0.21.9: operator wallet that funds sandbox billing. Surfaced to
     * `account.balance` brain tool so the sandbox billing reserve lookup
     * has a recipient. Optional for backwards-compat with older provisions. */
    operator?: Address
  }
  /** v0.21.9: deployment target ('local' or 'sandbox'). Surfaced to
   * `account.balance` brain tool so the sandbox billing reserve only
   * appears for sandbox-deployed agents. Defaults to 'local' if absent. */
  deployTarget?: 'local' | 'sandbox'
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
  /**
   * v0.21.0: agent self-funds compute bills out of its EOA. Mirror of the
   * `economy.autoTopup` field in the operator's anima.config.ts.
   */
  economy?: {
    autoTopup?: {
      enabled?: boolean
      pollIntervalMs?: number
      compute?: {
        lowThreshold?: number
        topUpAmount?: number
        maxPerDay?: number
      }
      wallet?: {
        notifyThreshold?: number
        minRetainedAfterTopup?: number
      }
    }
  }
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
 * v0.21.5: result of a manual auto-topup tick. `ok:true` means the manager
 * ran a poll cycle and emitted whatever events it saw fit (topup-fired /
 * topup-skipped / topup-failed / wallet-low). `ok:false` is reserved for
 * "manager not configured" or runtime not started.
 */
export interface TriggerTopupTickResult {
  ok: boolean
  reason?: 'autotopup-disabled' | 'runtime-not-started' | string
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
  /**
   * v0.21.5: force the AutoTopupManager to run one tick now (bypassing the
   * 5-minute poll interval). Returns ok:false with reason='autotopup-disabled'
   * when the runtime has no manager wired (economy.autoTopup.enabled === false
   * or brain.provider unset). Returns ok:true after the tick completes; the
   * actual outcome (fired/skipped/failed) flows through the existing event
   * + activity-log surfaces, NOT this return value.
   */
  triggerTopupTick?(): Promise<TriggerTopupTickResult>
  /**
   * v0.21.12: report the high-level state of each registered listener so
   * `/healthz` can expose `listeners.telegram` etc. without parsing logs.
   * 'disabled' = listener not configured (e.g. no telegram-secrets blob).
   * 'active' = listener registered + started without throwing.
   * 'failed' = registered but start() threw OR a runtime invariant violated.
   */
  listenerStates?(): Record<string, 'active' | 'disabled' | 'failed'>
  /**
   * v0.21.13: report the current permission mode so `/healthz` consumers
   * (notably the TUI thin client) can render an accurate statusline. Without
   * this the TUI hardcoded `approvalsMode: 'off'` after the v0.19.0 thin-client
   * refactor and never reflected `/perms` / `/yolo` flips that the gateway
   * routed through `dispatchBypass`. Returns undefined if the runtime hasn't
   * yet wired its PermissionService (e.g. pre-Ready).
   */
  permissionMode?(): 'off' | 'prompt' | 'strict' | undefined
  /**
   * v0.23.0: snapshot of every IntelligentData slot's high-level status so
   * `/healthz` can show whether profile/identity/persona/MEMORY are anchored,
   * pending, or skipped. Same semantics as `restoreOutcomes` from boot, kept
   * fresh as flushes + lazy restores complete.
   */
  slotStatus?(): Record<string, { status: string; reason?: string; bytes?: number }>
  /**
   * v0.23.0: live-flip the operator-scoped PROFILE key. Called when the
   * operator runs `anima profile init` against a sandbox endpoint; the
   * gateway forwards the raw 32-byte key (hex-encoded over a sealed channel
   * verified by sig) here so the sync-manager picks it up on the next flush.
   * Returns ok:false with reason='profile-unsupported' when the runtime
   * doesn't have an active MemorySyncManager (e.g. pre-Ready or stub).
   */
  setProfileKey?(keyHex: `0x${string}`): Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * v0.24.4: approve a pending pairing code in the container's canonical
   * pairing dir (`~/.anima/agents/<id>/pairing`). Backs the
   * `/admin/pairing/approve` endpoint so the host CLI can route pair-mode
   * approvals to sandbox-deployed agents without SSHing into the container.
   * `ok:true` returns the approved user's id + name; `ok:false` returns one
   * of `unknown-or-expired-code | locked-out | runtime-not-started`.
   */
  approvePairing?(
    platform: string,
    code: string,
  ): { ok: true; userId: string; userName: string } | { ok: false; reason: string }
}
