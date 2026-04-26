import type { Listener } from '../events/listeners'
import type { ToolRegistry } from '../tools/registry'
import type { ToolDef } from '../tools/types'
import type { HookBus, HookHandler, HookName } from './hooks'

/**
 * Context handed to a plugin's `register(ctx)` function. Plugins use this
 * to contribute tools, listeners, and lifecycle hooks; we deliberately
 * keep the surface tiny so future plugin features extend it without
 * breaking existing native plugins.
 */
export interface PluginContext {
  registerTool: (def: ToolDef) => void
  registerListener: (l: Listener) => void
  addHook: <TIn = unknown, TOut = void>(name: HookName, fn: HookHandler<TIn, TOut>) => void
  /** Network the agent is configured for. */
  network: '0g-mainnet' | '0g-testnet'
  /** Agent state directory (`~/.anima/agents/<id>/`). */
  agentDir: string
  /** Per-agent unique id (matches `iNFTAgentId(...)` for non-stub agents). */
  agentId: string
}

export interface NativePlugin {
  name: string
  register: (ctx: PluginContext) => void | Promise<void>
}

export interface PluginLoadResult {
  loaded: string[]
  errors: { plugin: string; error: string }[]
}

export interface PluginLoaderDeps {
  tools: ToolRegistry
  hooks: HookBus
  listeners: { register: (l: Listener) => void }
  agentDir: string
  agentId: string
  network: '0g-mainnet' | '0g-testnet'
  /**
   * Resolver for `name` → ESM module path. Defaults to dynamic import of
   * `@s0nderlabs/anima-plugin-<name>`. Tests pass a stub.
   */
  resolve?: (name: string) => Promise<{ default?: NativePlugin } & Partial<NativePlugin>>
}

export async function loadPlugins(
  names: readonly string[],
  deps: PluginLoaderDeps,
): Promise<PluginLoadResult> {
  const loaded: string[] = []
  const errors: PluginLoadResult['errors'] = []
  const ctx: PluginContext = {
    registerTool: def => deps.tools.register(def),
    registerListener: l => deps.listeners.register(l),
    addHook: (name, fn) => deps.hooks.add(name, fn),
    network: deps.network,
    agentDir: deps.agentDir,
    agentId: deps.agentId,
  }
  for (const name of names) {
    try {
      const mod = deps.resolve
        ? await deps.resolve(name)
        : ((await import(`@s0nderlabs/anima-plugin-${name}`)) as {
            default?: NativePlugin
          } & Partial<NativePlugin>)
      const plugin: NativePlugin | undefined =
        mod.default && 'register' in mod.default
          ? mod.default
          : 'register' in mod && typeof mod.register === 'function'
            ? (mod as unknown as NativePlugin)
            : undefined
      if (!plugin) {
        errors.push({ plugin: name, error: 'no exported register(ctx)' })
        continue
      }
      await plugin.register(ctx)
      loaded.push(name)
    } catch (e) {
      errors.push({ plugin: name, error: (e as Error).message ?? String(e) })
    }
  }
  return { loaded, errors }
}
