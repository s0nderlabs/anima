import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AnimaConfig } from '@s0nderlabs/anima-core'

export interface RenderConfigOpts {
  header?: string
  subname?: string | null
}

/** Serialize an AnimaConfig into a `anima.config.ts` file body. */
export function renderConfigTs(cfg: AnimaConfig, opts: RenderConfigOpts = {}): string {
  const header = opts.header ?? ''
  const subnameLine =
    opts.subname !== undefined ? `  subname: ${JSON.stringify(opts.subname)},\n` : ''
  return `import { defineConfig } from '@s0nderlabs/anima-core'
${header ? `\n${header}\n` : ''}
export default defineConfig({
  identity: { iNFT: ${JSON.stringify(cfg.identity.iNFT)} },
  network: ${JSON.stringify(cfg.network)},
  storage: { network: ${JSON.stringify(cfg.storage.network)} },
  brain: {
    provider: ${JSON.stringify(cfg.brain.provider)},
    model: ${JSON.stringify(cfg.brain.model)},
  },
  plugins: ${JSON.stringify(cfg.plugins)},
  tools: ${JSON.stringify(cfg.tools)},
  imports: { claudeCode: ${cfg.imports.claudeCode} },
${subnameLine}})
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
