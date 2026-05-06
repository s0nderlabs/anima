/**
 * User-facing configuration shape for `anima.config.ts`.
 *
 * Example:
 *
 *   import { defineConfig } from '@s0nderlabs/anima-core'
 *
 *   export default defineConfig({
 *     identity: { iNFT: null },               // iNFT token id once minted
 *     network: '0g-mainnet',                  // or '0g-testnet'
 *     storage: { network: '0g-mainnet' },
 *     brain: { provider: '0xd9966e...' },     // chosen at `anima init`
 *     plugins: ['onchain', 'comms', 'system'],
 *     tools: { 'defi.*': false, 'shell.run': false },
 *     imports: { claudeCode: true },
 *   })
 */

export type AnimaNetwork = '0g-mainnet' | '0g-testnet'

export type AnimaPlugin = 'onchain' | 'comms' | 'system' | 'telegram'

export interface INFTRef {
  /** ERC-7857 contract address. */
  contract: string
  /** Token id minted to the owner at `anima init`. */
  tokenId: string
  /** Network where the iNFT lives. */
  network: AnimaNetwork
  /**
   * Block at which the iNFT was minted. Used as the floor for Transfer-event
   * discovery scans (`chain.balance` no-arg). Optional for backward compat;
   * pre-Phase-10 configs lack this and the harness backfills lazily by
   * scanning ERC-721 Transfer logs for the tokenId.
   */
  mintBlock?: string
}

export type OperatorSourceKind = 'walletconnect' | 'keychain' | 'keystore-file' | 'raw-privkey'

/**
 * Persisted hint about which operator source to use when commands like
 * `anima` (chat), `anima topup`, and `anima restore` need to talk to the
 * operator wallet again. Stores enough metadata to reconstruct the signer
 * without re-prompting the user from scratch (passphrases / QR scans still
 * happen because they're per-session).
 */
export interface OperatorSourceHint {
  source: OperatorSourceKind
  /** Only for `keychain`: the macOS Keychain service name to read. */
  keychainService?: string
  /** Only for `keystore-file`: absolute or `~`-prefixed path to the JSON keystore. */
  keystorePath?: string
}

export interface AnimaConfig {
  identity: {
    iNFT: INFTRef | null
    /** Operator wallet address that owns the iNFT (section 22.1). */
    operator: string | null
    /** Agent EOA address (separate key, pays infra gas). */
    agent: string | null
  }
  network: AnimaNetwork
  storage: {
    network: AnimaNetwork
  }
  brain: {
    provider: string | null
    model: string | null
    /**
     * v0.20.0: max assistant output tokens per turn. Default 4096 (was 1024).
     */
    maxOutputTokens?: number
    /**
     * v0.20.0: model context window. Used for auto-compaction trigger.
     * Default 1_000_000 (Qwen 1M target). Override for smaller models.
     */
    contextWindow?: number
    /**
     * v0.20.0: pre-flight summarize-fold of older history when running
     * estimate breaches `threshold * contextWindow`. Set to `null` to
     * disable. Default: { threshold: 0.5, keepRecent: 8 }.
     */
    compaction?: {
      threshold?: number
      keepRecent?: number
    } | null
    /**
     * v0.20.0: persist channel histories to JSONL under
     * `~/.anima/agents/<id>/conversations/`. Loaded on boot, appended per
     * turn, atomically rewritten on compaction. Default true.
     */
    persistConversations?: boolean
  }
  plugins: AnimaPlugin[]
  /** Glob-level tool allow/deny. Right-most match wins. */
  tools: Record<string, boolean>
  imports: {
    claudeCode: boolean
  }
  /**
   * Phase 6.6: which operator source to use when reconnecting. Optional so
   * legacy v0.5.0 configs still parse; commands fall back to the interactive
   * picker when this is missing.
   */
  operator?: OperatorSourceHint | null
  /**
   * Phase 7: the agent's `<label>.anima.0g` subname (without the suffix).
   * Recorded by `anima init` so the chat loop can auto-publish the agent's
   * pubkey text record on every launch (idempotent backfill for pre-Phase-7
   * agents). Optional — agents without a subname skip the publish.
   */
  subname?: string | null
  /**
   * Phase 9.0: permission system. `prompt` (default) prompts on dangerous
   * commands; `strict` always denies them; `off` is YOLO (no prompts).
   * `--yolo` CLI flag and `/yolo` TUI slash both flip the active service to
   * 'off' for the current session without rewriting the file.
   */
  approvals?: {
    mode: 'strict' | 'prompt' | 'off'
    /** Always-approved patterns (regex against `kind|command|path` signature). */
    allowlist?: string[]
  }
  /**
   * Phase 9.1: skills system. `disabled` is the persistent list of skill ids
   * that should never auto-load or appear in the index. Updated by
   * `skills.manage` and persisted to ~/.anima/config.ts.
   */
  skills?: {
    disabled?: string[]
  }
  /**
   * v0.9.3: operator-supplied additions to the system prompt. `append` is
   * concatenated under a `# Operator instructions` header AFTER anima's
   * built-in safety + tool-use scaffolding. Can NOT replace the base prompt;
   * use it for personal rules ("always reply in Indonesian", "prefer Bun
   * over npm", "follow our team commit convention").
   */
  prompt?: {
    append?: string | null
  }
  /**
   * v0.9.4 (Apr 28 2026): structural sandbox for limb spawns. Defense-in-depth
   * BENEATH the permission floor — even when `s` (allow session) or yolo grants
   * a destructive command, the sandbox profile prevents writes outside an
   * allowlist (agentDir + workspaceRoot + /tmp/anima-* + /var/folders).
   *
   *  - `none` (default): passthrough, today's behaviour. Permission floor only.
   *  - `os`: native OS sandbox. macOS = sandbox-exec wrapper. Linux = bubblewrap
   *    (post-MVP, falls back to passthrough with warning until impl lands).
   *    Catches the rm-cascading-into-orphan-daemons class of incident.
   *  - `docker`: long-lived container per session, every spawn through `docker
   *    exec`. NOT YET IMPLEMENTED — separate Phase 9.5 follow-up bundle.
   */
  /**
   * v0.11 (Apr 29 2026): vision tool routing. Multimodal limbs (vision.analyze,
   * browser.vision) call this provider on the same compute ledger; the brain
   * stays on `brain.provider`. Defaults to qwen3-vl-30b-a3b-instruct on
   * mainnet (the only vision provider on 0G Compute today). Set `null` to
   * disable; tools then return a clear "not configured" error.
   */
  vision?: {
    provider?: string | null
  }
  /**
   * v0.21.0 (May 6 2026): agent funds its own infra bills out of its EOA.
   * The compute ledger envelope for `brain.provider` is monitored every
   * `pollIntervalMs`; when it drops below `compute.lowThreshold`, the
   * gateway calls `broker.ledger.depositFund` + `transferFund` signed by
   * the agent's private key. Operator gets notified via TG and TUI when
   * topup fires, when wallet drops below `wallet.notifyThreshold`, or
   * when topup fails (RPC, insufficient agent balance, daily cap reached).
   * Set `enabled: false` to disable; defaults are tuned for hackathon use.
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
  /**
   * Phase 11 (May 2026): where the harness physically runs.
   *
   *  - `local` (default): harness lives on this machine while `anima` chat is
   *    open. Listeners run only when CLI is open. Use for dev / always-on
   *    laptop / VPS / home server.
   *  - `sandbox`: harness runs in a 0G Sandbox TDX TEE container. Persistent
   *    even when the operator laptop is closed. Set by `anima init --target
   *    sandbox` or `anima deploy`. Co-exists with `sandbox.id`/`endpoint` etc
   *    fields below.
   */
  deployTarget?: 'local' | 'sandbox'
  sandbox?: {
    /**
     * Phase 11: 0G Sandbox container UUID returned by `POST /api/sandbox`.
     * Only set when `deployTarget === 'sandbox'`.
     */
    id?: string
    /**
     * Phase 11: provider wallet address (Galileo testnet). Identifies which
     * sandbox provider hosts this agent's container. Used for settlement
     * deposit/withdraw and `getSandbox` lookups.
     */
    providerAddress?: string
    /**
     * Phase 11: full URL of the harness HTTP server inside the container,
     * routed through the provider's nip.io reverse proxy.
     * Format: `http://<port>-<sandboxId>.43.106.147.28.nip.io:4000`.
     */
    endpoint?: string
    /**
     * Phase 11: snapshot name passed to `createSandbox`. Default
     * `daytonaio/sandbox:0.5.0-slim`. Override for resource needs (e.g.
     * `openclaw` for 2C/4G/10G).
     */
    snapshotName?: string
    mode?: 'none' | 'os' | 'docker'
    /**
     * docker mode only: container image. Default `oven/bun:1`. Compatible
     * with Docker Desktop AND Podman (CLI-compatible). Override for custom
     * tooling: `nikolaik/python-nodejs:python3.11-nodejs20`, etc.
     */
    dockerImage?: string
    /**
     * docker mode only: bind-mount the host's workspaceRoot into the
     * container at /workspace. Default `false` for max isolation. Set true
     * if the agent should read/edit your project files.
     */
    dockerMountWorkspace?: boolean
    /**
     * docker mode only: force a specific container runtime binary. Auto-detect
     * by default (tries docker, then podman). Override e.g. to
     * `/opt/homebrew/bin/podman` to bypass a docker symlink.
     */
    dockerRuntimePath?: string
    /**
     * docker mode only: CPU cores cap (`--cpus`). Float (1.5 = 1.5 cores).
     * Default unlimited (no cap). Set e.g. `1` to mirror hermes' default cap.
     */
    dockerCpu?: number
    /**
     * docker mode only: memory cap in MB (`--memory <N>m`). Default unlimited.
     * Hermes default is 5120 (5GB); leaving unset is anima's default so the
     * container competes fairly with host work without OOM-killing surprise.
     */
    dockerMemoryMb?: number
    /**
     * docker mode only: per-container writable-layer disk cap in MB. Linux +
     * overlay2 with pquota only — silently dropped on macOS Docker Desktop /
     * podman machine. Hermes default is 51200 (50GB).
     */
    dockerDiskMb?: number
    /**
     * docker mode only: block all network access from inside the container
     * (`--network=none`). Default false (network reaches the internet through
     * the runtime's bridge). Useful for max-paranoia code.execute that should
     * never call out.
     */
    dockerNoNetwork?: boolean
  }
}

export type AnimaConfigInput = Partial<AnimaConfig> & Pick<AnimaConfig, 'network'>

const DEFAULT_CONFIG: Omit<AnimaConfig, 'network' | 'storage'> = {
  identity: { iNFT: null, operator: null, agent: null },
  brain: { provider: null, model: null },
  plugins: ['onchain', 'comms', 'system'],
  tools: {},
  imports: { claudeCode: true },
  operator: null,
  subname: null,
  approvals: { mode: 'prompt', allowlist: [] },
  skills: { disabled: [] },
  prompt: { append: null },
  vision: { provider: undefined },
  deployTarget: 'local',
  sandbox: { mode: 'none' },
}

export function defineConfig(input: AnimaConfigInput): AnimaConfig {
  return {
    ...DEFAULT_CONFIG,
    identity: input.identity ?? DEFAULT_CONFIG.identity,
    network: input.network,
    storage: input.storage ?? { network: input.network },
    brain: input.brain ?? DEFAULT_CONFIG.brain,
    plugins: input.plugins ?? DEFAULT_CONFIG.plugins,
    tools: input.tools ?? DEFAULT_CONFIG.tools,
    imports: input.imports ?? DEFAULT_CONFIG.imports,
    operator: input.operator ?? DEFAULT_CONFIG.operator,
    subname: input.subname ?? DEFAULT_CONFIG.subname,
    approvals: input.approvals ?? DEFAULT_CONFIG.approvals,
    skills: input.skills ?? DEFAULT_CONFIG.skills,
    prompt: input.prompt ?? DEFAULT_CONFIG.prompt,
    vision: input.vision ?? DEFAULT_CONFIG.vision,
    deployTarget: input.deployTarget ?? DEFAULT_CONFIG.deployTarget,
    sandbox: input.sandbox ?? DEFAULT_CONFIG.sandbox,
  }
}

export const NETWORK_RPC: Record<AnimaNetwork, string> = {
  '0g-mainnet': 'https://evmrpc.0g.ai',
  '0g-testnet': 'https://evmrpc-testnet.0g.ai',
}

export const NETWORK_CHAIN_ID: Record<AnimaNetwork, number> = {
  '0g-mainnet': 16661,
  '0g-testnet': 16602,
}

export function networkFromChainId(id: number): AnimaNetwork | null {
  return (Object.entries(NETWORK_CHAIN_ID).find(([, cid]) => cid === id)?.[0] ??
    null) as AnimaNetwork | null
}
