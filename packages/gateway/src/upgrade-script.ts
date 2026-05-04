/**
 * In-place upgrade script template. Used by `anima upgrade` (default flow,
 * v0.17.0+) to swap the harness inside an EXISTING Daytona container rather
 * than re-provisioning a fresh one. Sister of `bootstrap.ts`.
 *
 * Why in-place: per `feedback-anima-is-unsealed-currently.md`, our Phase 11
 * deployment is unsealed (no image-hash attestation, no TDX-bound signer).
 * Heavy container swap buys no real attestation, only ~0.9 0G testnet burn
 * per upgrade + 60-90s downtime. In-place buys the same code-rolling-forward
 * for $0 + ~30s downtime. See `decision-upgrade-in-place-default.md`.
 *
 * Same Daytona constraints as bootstrap:
 *  - `process/execute` caps each call at ~60s, so the slow work (git fetch,
 *    bun install, harness restart) detaches into a `nohup bash -c '...' &`
 *    background subshell.
 *  - Progress via two files: `/tmp/anima-upgrade-progress.log` (tail-able),
 *    `/tmp/anima-upgrade-done` (success only, contains harness pid).
 *  - Failure markers in `/tmp/anima-upgrade-failed` for each step's distinct
 *    failure keyword (`git-fetch-failed`, `git-checkout-failed`, etc.).
 *
 * What it does NOT do (intentionally; these are bootstrap-only concerns):
 *  - apt-get update/install (already installed in the existing container)
 *  - bun binary install (already installed)
 *  - git clone (`~/anima` already exists; we git fetch + checkout instead)
 */

export interface BuildUpgradeScriptOpts {
  /** Sandbox UUID. Stays the same across upgrade (same container). */
  sandboxId: string
  /** EIP-191 checksummed operator address. Re-exported into harness env. */
  operatorAddress: string
  /** Git tag to checkout (e.g. 'v0.17.0'). Use 'main' or a SHA only for dev. */
  ref: string
  /**
   * Public git URL of anima. Defaults to canonical hackathon repo. Re-applied
   * via `git remote set-url origin` so a stale credential-helper URL doesn't
   * break the fetch.
   */
  repoUrl?: string
  /** Port the harness binds. Default 8080 (matches bootstrap). */
  port?: number
}

export interface BuildUpgradeScriptResult {
  script: string
  doneMarkerPath: string
  progressLogPath: string
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

const PROGRESS_LOG = '/tmp/anima-upgrade-progress.log'
const DONE_MARKER = '/tmp/anima-upgrade-done'
const FAIL_MARKER = '/tmp/anima-upgrade-failed'

export function buildUpgradeScript(opts: BuildUpgradeScriptOpts): BuildUpgradeScriptResult {
  const port = opts.port ?? 8080
  const repoUrl = opts.repoUrl ?? 'https://github.com/s0nderlabs/anima.git'

  // Inner subshell: detached via nohup. Same `retry()` shape as bootstrap so
  // future helper extraction across both scripts is mechanical. Different
  // fail-keywords because in-place has different failure modes than first-cold.
  const inner = [
    '#!/bin/bash',
    'set -uo pipefail',
    `exec > ${PROGRESS_LOG} 2>&1`,
    'echo "[$(date -u +%FT%TZ)] upgrade-start"',
    `echo "  ref=${opts.ref}"`,
    `echo "  sandbox=${opts.sandboxId}"`,
    'retry() {',
    '  local L=$1; shift',
    '  local n',
    '  for n in 1 2 3; do',
    '    echo "[$L attempt $n/3]"',
    '    "$@" && return 0',
    '    [ $n -lt 3 ] && { echo "[$L failed, retry in $((n*5))s]"; sleep $((n*5)); }',
    '  done',
    '  return 1',
    '}',
    'export PATH="$HOME/.bun/bin:$PATH"',
    `cd "$HOME/anima" || { echo "anima-dir-missing" > ${FAIL_MARKER}; exit 20; }`,
    `git remote set-url origin ${shQuote(repoUrl)} 2>/dev/null || true`,
    'git reset --hard HEAD 2>/dev/null || true',
    `retry 'git fetch' git fetch --tags --depth 50 origin || { echo "git-fetch-failed" > ${FAIL_MARKER}; exit 21; }`,
    `retry 'git checkout' git checkout ${shQuote(opts.ref)} || { echo "git-checkout-failed" > ${FAIL_MARKER}; exit 22; }`,
    `retry 'bun deps' bun install --frozen-lockfile || { echo "bun-install-failed" > ${FAIL_MARKER}; exit 23; }`,
    '',
    // Same browser-deps install as bootstrap. doctor probe makes upgrades
    // a no-op on the common case (Chromium already installed in the
    // container's persistent volume); only fresh provisions or a manual
    // wipe trigger the slow apt + Chromium download path.
    'echo "[browser deps]"',
    'if bunx agent-browser doctor >/dev/null 2>&1; then',
    '  echo "[browser deps] already installed, skipping"',
    'else',
    `  retry 'browser deps' bunx agent-browser install --with-deps || { echo "browser-install-failed" > ${FAIL_MARKER}; exit 25; }`,
    'fi',
    '',
    'echo "[restart gateway]"',
    'pkill -f anima-harness 2>/dev/null || true',
    'pkill -f anima-gateway 2>/dev/null || true',
    `fuser -k ${port}/tcp 2>/dev/null || true`,
    'sleep 3',
    '',
    // Wipe agent-scoped locks after the prior harness is dead so the new
    // instance starts clean. Insurance for older harness versions whose
    // shutdown didn't await listener teardown and could leak a stale TG
    // bot-token lockfile. See feedback-tg-token-lock-zombie-after-upgrade.md.
    'echo "[clear stale agent locks]"',
    'rm -f "$HOME/.anima/locks/"*.lock 2>/dev/null || true',
    '',
    `export SANDBOX_ID=${shQuote(opts.sandboxId)}`,
    `export ANIMA_OPERATOR_ADDRESS=${shQuote(opts.operatorAddress)}`,
    `export HARNESS_PORT=${shQuote(String(port))}`,
    "export HARNESS_HOST='0.0.0.0'",
    '',
    'mkdir -p "$HOME/anima-logs"',
    'HARNESS_PID=""',
    'HARNESS_OK=0',
    'for h_attempt in 1 2 3; do',
    '  echo "[launch attempt $h_attempt/3]"',
    `  fuser -k ${port}/tcp 2>/dev/null || true`,
    '  sleep 1',
    '  nohup bun "$HOME/anima/packages/gateway/bin/anima-gateway" > "$HOME/anima-logs/anima-gateway.log" 2>&1 &',
    '  HARNESS_PID=$!',
    '  disown',
    '  sleep 10',
    '  if kill -0 "$HARNESS_PID" 2>/dev/null; then',
    '    HARNESS_OK=1',
    '    break',
    '  fi',
    '  echo "[harness died on attempt $h_attempt, log tail:]"',
    '  tail -n 50 "$HOME/anima-logs/anima-gateway.log" 2>/dev/null',
    '  if [ $h_attempt -lt 3 ]; then',
    '    echo "[retrying in 5s]"',
    '    sleep 5',
    '  fi',
    'done',
    'if [ "$HARNESS_OK" -ne 1 ]; then',
    '  echo "[all 3 harness launch attempts failed, full log dump:]"',
    '  tail -n 200 "$HOME/anima-logs/anima-gateway.log" 2>/dev/null',
    `  echo "harness-died-early" > ${FAIL_MARKER}`,
    '  exit 24',
    'fi',
    `echo "anima-gateway-pid=$HARNESS_PID" > ${DONE_MARKER}`,
    'echo "[$(date -u +%FT%TZ)] upgrade-done pid=$HARNESS_PID"',
    '',
  ].join('\n')

  const innerPath = '/tmp/anima-upgrade-inner.sh'
  const innerB64 = Buffer.from(inner).toString('base64')
  const fileWrites = [
    `rm -f ${PROGRESS_LOG} ${DONE_MARKER} ${FAIL_MARKER}`,
    `echo ${innerB64} | base64 -d > ${innerPath}`,
    `chmod +x ${innerPath}`,
  ].join(' && ')
  const launchBody = `${fileWrites} && nohup bash ${innerPath} >/dev/null 2>&1 & echo upgrade-launched`
  const outerScript = `bash -c '${launchBody}'`

  return {
    script: outerScript,
    doneMarkerPath: DONE_MARKER,
    progressLogPath: PROGRESS_LOG,
  }
}

export const UPGRADE_DONE_MARKER = DONE_MARKER
export const UPGRADE_FAIL_MARKER = FAIL_MARKER
export const UPGRADE_PROGRESS_LOG = PROGRESS_LOG
export const UPGRADE_SUCCESS_MARKER_PREFIX = 'anima-gateway-pid='

/** Substring keywords the inner subshell writes to FAIL_MARKER on failure. */
export const UPGRADE_FAIL_KEYWORDS = [
  'anima-dir-missing',
  'git-fetch-failed',
  'git-checkout-failed',
  'bun-install-failed',
  'browser-install-failed',
  'harness-died-early',
] as const
