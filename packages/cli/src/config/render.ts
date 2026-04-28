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
  // Phase 9.5 / v0.10.1: emit either the operator's chosen sandbox config OR an
  // annotated "OPTION 1/2/3" block so the operator can opt in by uncommenting.
  // Mirrors hermes-agent's cli-config.yaml.example pattern: documentation IS
  // the UX, not an interactive wizard. Default mode stays `none` (passthrough)
  // for back-compat.
  const sandboxBlock = renderSandboxBlock(cfg.sandbox)
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
${operatorLine}${subnameLine}${sandboxBlock}}
`
}

function renderSandboxBlock(sandbox: AnimaConfig['sandbox']): string {
  // Operator already configured something: emit it verbatim, no template.
  if (sandbox?.mode && sandbox.mode !== 'none') {
    return `  sandbox: ${JSON.stringify(sandbox, null, 2).replace(/\n/g, '\n  ')},\n`
  }
  // Fresh install: write the active default + commented examples for the
  // other tiers. Operator can opt in by uncommenting and editing.
  return `  sandbox: { mode: 'none' },
  // ---------------------------------------------------------------------------
  //  Limb sandbox (Phase 9.5). Defense-in-depth beneath the permission floor:
  //  even when the modal grants 'allow session' or YOLO disables prompts,
  //  the sandbox profile/container blocks writes outside an allowlist.
  //  All shell.run / code.execute / shell.process_start spawns route through
  //  the chosen backend. fs.* and browser.* still run on the host (PathGuard
  //  applies). Override at runtime via ANIMA_SANDBOX_MODE=os|docker|none.
  //
  //  OPTION 1: none (default): passthrough, fastest, permission floor only.
  //
  //  OPTION 2: os (macOS sandbox-exec / seatbelt). Allows writes to agentDir +
  //    cwd + /tmp/anima-* + /var/folders. Denies reads of ~/.ssh, ~/.aws,
  //    ~/Library/Keychains, ~/.config/gcloud. Linux bubblewrap pending.
  //  sandbox: { mode: 'os' },
  //
  //  OPTION 3: docker (long-lived container per session), every shell-class
  //    spawn through 'docker exec'. Auto-detects Docker Desktop or Podman.
  //    Default image 'nikolaik/python-nodejs:python3.11-nodejs20' (matches
  //    hermes; ~700 MB; bash + python3 + node + npm + git on standard PATH).
  //    Override with 'oven/bun:1' (~250 MB) if you only need bun/ts.
  //    'dockerMountWorkspace: true' bind-mounts your launch cwd into
  //    /workspace (off by default for max isolation). 'dockerRuntimePath'
  //    forces a specific runtime binary.
  //  sandbox: {
  //    mode: 'docker',
  //    dockerImage: 'nikolaik/python-nodejs:python3.11-nodejs20',
  //    dockerMountWorkspace: false,
  //    // dockerRuntimePath: '/opt/homebrew/bin/podman',
  //  },
  // ---------------------------------------------------------------------------
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
