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

export type AnimaPlugin = 'onchain' | 'comms' | 'system'

export interface INFTRef {
  /** ERC-7857 contract address. */
  contract: string
  /** Token id minted to the owner at `anima init`. */
  tokenId: string
  /** Network where the iNFT lives. */
  network: AnimaNetwork
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
  sandbox?: {
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
  approvals: { mode: 'prompt', allowlist: [] },
  skills: { disabled: [] },
  prompt: { append: null },
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
    approvals: input.approvals ?? DEFAULT_CONFIG.approvals,
    skills: input.skills ?? DEFAULT_CONFIG.skills,
    prompt: input.prompt ?? DEFAULT_CONFIG.prompt,
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
