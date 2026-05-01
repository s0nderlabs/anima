/**
 * Bootstrap script template for first-cold-start of an anima harness inside
 * a 0G Sandbox container. Returned as a string the init/deploy/upgrade
 * commands feed to `provider-client.execInToolbox(id, { command })`.
 *
 * Goals:
 *  1. Install runtime deps (bun, git, system libs for chromium/Xvfb).
 *  2. Pull anima source pinned to a specific git tag.
 *  3. Install package deps via bun install (frozen lockfile).
 *  4. Launch `anima-harness` in the background with required env vars.
 *  5. Echo the harness pid so the caller can verify launch.
 *
 * Robustness rules:
 *  - `set -e` so the first failure surfaces (bash drops back to caller with
 *    non-zero exit code, which provider-client.execInToolbox surfaces as
 *    `exitCode !== 0`).
 *  - All variables shell-quote-escaped to defeat injection from the operator
 *    address or sandbox id (both are validated before reaching here, but
 *    defense-in-depth).
 *  - `nohup` + `&` + `&> /var/log/anima-harness.log` so the harness survives
 *    the exec session ending. provider-client returns when the script
 *    finishes, so without nohup the harness would die.
 *  - Idempotent install: if /opt/anima already exists, fetches + checkouts
 *    the requested tag rather than failing on `git clone`.
 */

export interface BuildBootstrapScriptOpts {
  /** Sandbox UUID returned by provider's createSandbox. */
  sandboxId: string
  /** EIP-191 checksummed operator address. Stored in container env, used by `verifyChatSig`. */
  operatorAddress: string
  /** Git tag to clone (e.g. 'v0.15.0'). Use 'main' or a SHA only for dev. */
  ref: string
  /**
   * Public git URL of anima. Defaults to the canonical hackathon repo.
   * Override only when running against a fork / private mirror.
   */
  repoUrl?: string
  /** Port the harness binds inside the container. Default 8080. */
  port?: number
  /**
   * Extra `apt-get install` packages. Defaults to chromium + xvfb (for browser
   * tools) + git + ca-certificates + curl + unzip. Caller can append (e.g. for
   * specific MCP server deps).
   */
  extraAptPackages?: string[]
}

export interface BuildBootstrapScriptResult {
  /** Multi-line bash script. Pass to `provider-client.execInToolbox(id, { command })`. */
  script: string
  /** Echo line the harness emits on successful launch (caller can grep for it). */
  successMarker: string
}

/**
 * Quote a string for safe inclusion in a single-quoted bash literal.
 * Single-quoted strings forbid `'`; we escape it as `'\''`.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

const DEFAULT_APT_PACKAGES: readonly string[] = [
  'curl',
  'unzip',
  'ca-certificates',
  'git',
  'xvfb',
  'chromium',
] as const

const SUCCESS_MARKER_PREFIX = 'anima-harness-pid='

export function buildBootstrapScript(opts: BuildBootstrapScriptOpts): BuildBootstrapScriptResult {
  const port = opts.port ?? 8080
  const repoUrl = opts.repoUrl ?? 'https://github.com/s0nderlabs/anima.git'
  const aptPkgs = [...DEFAULT_APT_PACKAGES, ...(opts.extraAptPackages ?? [])]
  // Dedupe: each package once.
  const aptList = [...new Set(aptPkgs)].join(' ')

  const successMarker = `${SUCCESS_MARKER_PREFIX}<pid>`
  const script = [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    '# anima harness bootstrap',
    `#   sandbox=${opts.sandboxId}`,
    `#   ref=${opts.ref}`,
    `#   repo=${repoUrl}`,
    `#   operator=${opts.operatorAddress}`,
    '',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    `apt-get install -y -qq ${aptList}`,
    '',
    '# Install bun (idempotent: bun.sh script no-ops if already present)',
    'if ! command -v bun >/dev/null 2>&1; then',
    '  curl -fsSL https://bun.sh/install | bash',
    'fi',
    'export PATH="$HOME/.bun/bin:$PATH"',
    '',
    '# Clone or fetch anima at the requested ref',
    'if [ ! -d /opt/anima/.git ]; then',
    `  git clone --depth 1 --branch ${shQuote(opts.ref)} ${shQuote(repoUrl)} /opt/anima`,
    'else',
    '  cd /opt/anima',
    `  git fetch --depth 1 origin ${shQuote(opts.ref)}`,
    '  git checkout --quiet FETCH_HEAD',
    'fi',
    '',
    'cd /opt/anima',
    'bun install --frozen-lockfile',
    '',
    'mkdir -p /var/log /workspace',
    '',
    '# Launch harness daemon. nohup + & detaches from this exec session so the',
    '# harness survives the toolbox/exec request closing. Output goes to the',
    '# log file the operator can tail via `anima logs`.',
    `export SANDBOX_ID=${shQuote(opts.sandboxId)}`,
    `export ANIMA_OPERATOR_ADDRESS=${shQuote(opts.operatorAddress)}`,
    `export HARNESS_PORT=${shQuote(String(port))}`,
    `export HARNESS_HOST='0.0.0.0'`,
    'nohup bun /opt/anima/packages/harness/bin/anima-harness > /var/log/anima-harness.log 2>&1 &',
    'HARNESS_PID=$!',
    'disown',
    '',
    '# Wait briefly to confirm the process actually starts (avoids reporting',
    '# success when bun crashes immediately on a syntax error / missing dep).',
    'sleep 2',
    'if ! kill -0 "$HARNESS_PID" 2>/dev/null; then',
    '  echo "anima-harness exited within 2s, dumping log:" >&2',
    '  tail -n 200 /var/log/anima-harness.log >&2 || true',
    '  exit 1',
    'fi',
    'echo "anima-harness-pid=$HARNESS_PID"',
    '',
  ].join('\n')

  return { script, successMarker }
}

export const BOOTSTRAP_SUCCESS_MARKER_PREFIX = SUCCESS_MARKER_PREFIX
