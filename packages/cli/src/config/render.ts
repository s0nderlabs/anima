import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AnimaConfig } from '@s0nderlabs/anima-core'

export interface RenderConfigOpts {
  header?: string
  subname?: string | null
}

/**
 * Serialize an AnimaConfig into a `~/.anima/config.ts` file body.
 *
 * Phase 6.6: the config lives at `~/.anima/config.ts` which is outside any
 * workspace, so it MUST NOT import `@s0nderlabs/anima-core` (the import won't
 * resolve from `~/.anima/`). We emit a plain `export default { ... }` object;
 * the runtime loader treats it as `AnimaConfig` directly.
 */
export function renderConfigTs(cfg: AnimaConfig, opts: RenderConfigOpts = {}): string {
  const header = opts.header ?? ''
  const subnameLine =
    opts.subname !== undefined ? `  subname: ${JSON.stringify(opts.subname)},\n` : ''
  const operatorLine = cfg.operator ? `  operator: ${JSON.stringify(cfg.operator)},\n` : ''
  return `${header ? `${header}\n\n` : ''}export default {
  identity: ${JSON.stringify(cfg.identity)},
  network: ${JSON.stringify(cfg.network)},
  storage: { network: ${JSON.stringify(cfg.storage.network)} },
  brain: {
    provider: ${JSON.stringify(cfg.brain.provider)},
    model: ${JSON.stringify(cfg.brain.model)},
  },
  plugins: ${JSON.stringify(cfg.plugins)},
  tools: ${JSON.stringify(cfg.tools)},
  imports: { claudeCode: ${cfg.imports.claudeCode} },
${operatorLine}${subnameLine}}
`
}

export async function writeConfigTs(
  path: string,
  cfg: AnimaConfig,
  opts: RenderConfigOpts = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, renderConfigTs(cfg, opts), 'utf8')
}
