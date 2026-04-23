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

export interface AnimaConfig {
  identity: {
    iNFT: string | null
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
}

export type AnimaConfigInput = Partial<AnimaConfig> & Pick<AnimaConfig, 'network'>

const DEFAULT_CONFIG: Omit<AnimaConfig, 'network' | 'storage'> = {
  identity: { iNFT: null },
  brain: { provider: null, model: null },
  plugins: ['onchain', 'comms', 'system'],
  tools: {},
  imports: { claudeCode: true },
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
