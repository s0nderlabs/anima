/**
 * Bootstrap script template for first-cold-start of an anima harness inside
 * a 0G Sandbox container. Returned as a string the init/deploy/upgrade
 * commands feed to `provider-client.execInToolbox(id, { command })`.
 *
 * Design constraint: the Daytona toolbox `process/execute` endpoint caps each
 * exec call at ~60s. apt-get install (chromium + xvfb) plus bun install on
 * the anima monorepo blow that easily (3-5 min cold start). We solve this by
 * detaching the slow work into a background subshell via `nohup bash -c '...' &`
 * and returning exit 0 immediately. Progress is observable via two files the
 * background subshell writes:
 *
 *  - `/tmp/anima-bootstrap-progress.log` (tail-able, line-by-line stages)
 *  - `/tmp/anima-bootstrap-done` (created only on full success, contains harness pid)
 *
 * The caller (`sandbox-provision.ts`) launches the bootstrap, polls for the
 * `done` marker (then for `/bootstrap/pubkey` from the harness HTTP server).
 *
 * Robustness rules:
 *  - All variables shell-quote-escaped to defeat injection from operator
 *    address or sandbox id (validated upstream, defense-in-depth).
 *  - Always-clone: the inner script `rm -rf "$ANIMA_DIR"` then `git clone`
 *    fresh. Daytona occasionally re-uses post-delete volumes whose stale
 *    git credential helpers break re-fetch, so we never trust an existing
 *    checkout. Cost is one extra clone per bootstrap (~5s).
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
   * tools) + git + ca-certificates + curl + unzip. Caller can append.
   */
  extraAptPackages?: string[]
  /**
   * GitHub PAT for cloning private anima repos. Embedded in clone URL as
   * `https://x-access-token:TOKEN@github.com/...`. For public repos, leave
   * unset. Token is base64-wrapped inside the inner script (which itself is
   * base64-encoded into the outer command), and the inner script is written
   * to /tmp on the container; ensure the container is single-tenant (Daytona
   * containers are by-operator). Gets cleared from container env after clone.
   */
  githubToken?: string
}

export interface BuildBootstrapScriptResult {
  /** Outer script: launches the inner subshell + returns exit 0. ~1s execution. */
  script: string
  /**
   * Path the caller should poll via `execInToolbox(id, { command: cat <path> })`
   * to detect bootstrap completion. Returns success line `anima-harness-pid=<N>`
   * once everything is up; absent until then.
   */
  doneMarkerPath: string
  /** Path the caller can tail to surface bootstrap progress. */
  progressLogPath: string
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

const PROGRESS_LOG = '/tmp/anima-bootstrap-progress.log'
const DONE_MARKER = '/tmp/anima-bootstrap-done'
const FAIL_MARKER = '/tmp/anima-bootstrap-failed'

export function buildBootstrapScript(opts: BuildBootstrapScriptOpts): BuildBootstrapScriptResult {
  const port = opts.port ?? 8080
  const repoUrl = opts.repoUrl ?? 'https://github.com/s0nderlabs/anima.git'
  const aptPkgs = [...DEFAULT_APT_PACKAGES, ...(opts.extraAptPackages ?? [])]
  const aptList = [...new Set(aptPkgs)].join(' ')
  // Auth-injected URL when token is supplied. Falls back to anonymous clone
  // for public repos.
  const cloneUrl = opts.githubToken
    ? repoUrl.replace(
        'https://github.com/',
        `https://x-access-token:${opts.githubToken}@github.com/`,
      )
    : repoUrl

  // Inner subshell: the slow work. Runs nohup'd in background. Heredoc body
  // single-quoted so all literal vars stay literal at the outer-shell layer;
  // we inject runtime fields via shQuote'd env exports at the top of inner.
  const inner = [
    '#!/bin/bash',
    'set -uo pipefail',
    '',
    '# Redirect everything to the progress log so operator can tail it.',
    `exec > ${PROGRESS_LOG} 2>&1`,
    '',
    'echo "[$(date -u +%FT%TZ)] bootstrap-start"',
    `echo "  ref=${opts.ref}"`,
    `echo "  repo=${repoUrl}"`,
    `echo "  sandbox=${opts.sandboxId}"`,
    '',
    'export DEBIAN_FRONTEND=noninteractive',
    '# Daytona container runs as non-root `daytona` user. apt-get + writes to',
    '# /var/log require sudo (passwordless). Anima clones to $HOME so no sudo.',
    'echo "[apt-get update]"',
    `sudo -n apt-get update -qq || { echo "apt-update-failed" > ${FAIL_MARKER}; exit 11; }`,
    `echo "[apt-get install ${aptList}]"`,
    `sudo -n apt-get install -y -qq ${aptList} || { echo "apt-install-failed" > ${FAIL_MARKER}; exit 12; }`,
    '',
    'if ! command -v bun >/dev/null 2>&1; then',
    '  echo "[install bun]"',
    `  curl -fsSL https://bun.sh/install | bash || { echo "bun-install-failed" > ${FAIL_MARKER}; exit 13; }`,
    'fi',
    'export PATH="$HOME/.bun/bin:$PATH"',
    '',
    'ANIMA_DIR="$HOME/anima"',
    '# Always clone fresh. Daytona sometimes leaves prior volumes after delete,',
    '# and re-using a stale checkout can break with cached credential helpers.',
    'rm -rf "$ANIMA_DIR"',
    '# Retry-with-backoff: github.com occasionally rate-limits Daytona shared IPs',
    '# or the container DNS is not yet warm. 3 attempts with 5s/10s backoff covers',
    '# the typical transient window. Confirmed needed on May 2 2026 wraith init.',
    'GIT_CLONE_OK=0',
    'for attempt in 1 2 3; do',
    `  echo "[git clone ${opts.ref} attempt $attempt/3]"`,
    `  if git clone --depth 1 --branch ${shQuote(opts.ref)} ${shQuote(cloneUrl)} "$ANIMA_DIR"; then`,
    '    GIT_CLONE_OK=1',
    '    break',
    '  fi',
    '  if [ $attempt -lt 3 ]; then',
    '    BACKOFF=$((attempt * 5))',
    '    echo "[git clone failed, retrying in ${BACKOFF}s]"',
    '    rm -rf "$ANIMA_DIR"',
    '    sleep $BACKOFF',
    '  fi',
    'done',
    `if [ "$GIT_CLONE_OK" -ne 1 ]; then echo "git-clone-failed" > ${FAIL_MARKER}; exit 14; fi`,
    `cd "$ANIMA_DIR" && git remote set-url origin ${shQuote(repoUrl)}`,
    '',
    'cd "$ANIMA_DIR"',
    'echo "[bun install]"',
    `bun install --frozen-lockfile || { echo "bun-install-failed" > ${FAIL_MARKER}; exit 17; }`,
    '',
    'mkdir -p "$HOME/anima-logs" "$HOME/workspace"',
    '',
    `export SANDBOX_ID=${shQuote(opts.sandboxId)}`,
    `export ANIMA_OPERATOR_ADDRESS=${shQuote(opts.operatorAddress)}`,
    `export HARNESS_PORT=${shQuote(String(port))}`,
    "export HARNESS_HOST='0.0.0.0'",
    '',
    '# Harness launch with 3-attempt retry. Verified May 2 2026 oracle init: bun',
    '# cold-start under Daytona container can race the kill -0 alive-check at',
    '# sleep 3, surfacing as "harness-died-early" even when the daemon is fine.',
    '# Bumping the per-attempt wait to 10s and adding 2 retries makes the launch',
    '# resilient to bun startup jitter without slowing the happy path.',
    'echo "[launch harness daemon]"',
    'HARNESS_PID=""',
    'HARNESS_OK=0',
    'for h_attempt in 1 2 3; do',
    '  echo "[harness launch attempt $h_attempt/3]"',
    '  nohup bun "$ANIMA_DIR/packages/harness/bin/anima-harness" > "$HOME/anima-logs/anima-harness.log" 2>&1 &',
    '  HARNESS_PID=$!',
    '  disown',
    '  # 10s gives bun time to import all packages, register listeners, and',
    '  # bind the HTTP server before we sample its liveness.',
    '  sleep 10',
    '  if kill -0 "$HARNESS_PID" 2>/dev/null; then',
    '    HARNESS_OK=1',
    '    break',
    '  fi',
    '  echo "[harness died on attempt $h_attempt, log tail:]"',
    '  tail -n 50 "$HOME/anima-logs/anima-harness.log" 2>/dev/null',
    '  if [ $h_attempt -lt 3 ]; then',
    '    echo "[retrying in 5s]"',
    '    sleep 5',
    '  fi',
    'done',
    'if [ "$HARNESS_OK" -ne 1 ]; then',
    '  echo "[all 3 harness launch attempts failed, full log dump:]"',
    '  tail -n 200 "$HOME/anima-logs/anima-harness.log" 2>/dev/null',
    `  echo "harness-died-early" > ${FAIL_MARKER}`,
    '  exit 18',
    'fi',
    `echo "anima-harness-pid=$HARNESS_PID" > ${DONE_MARKER}`,
    'echo "[$(date -u +%FT%TZ)] bootstrap-done pid=$HARNESS_PID"',
    '',
  ].join('\n')

  // Daytona's `process/execute` API does NOT run via a shell — it splits the
  // command string argv-style. Heredocs / pipes / `>` redirects fail because
  // they're passed as literal args to the first binary. To run our complex
  // inner script we base64-encode it (yields only [A-Za-z0-9+/=], no shell
  // metachars) and have `bash -c '...'` decode + write + launch. The single-
  // quoted bash -c wrapper has no internal quotes to escape.
  //
  // Sequencing rules:
  //   - File-write steps chain with `&&` (must succeed in order).
  //   - `nohup ... &` sends the inner script to background. After `&` you
  //     CANNOT use `&&` (syntax error: `& && X`) so we use `;` to follow up
  //     with the success marker echo. The launching shell exits ~instantly.
  const innerPath = '/tmp/anima-bootstrap-inner.sh'
  const innerB64 = Buffer.from(inner).toString('base64')
  const fileWrites = [
    `rm -f ${PROGRESS_LOG} ${DONE_MARKER} ${FAIL_MARKER}`,
    `echo ${innerB64} | base64 -d > ${innerPath}`,
    `chmod +x ${innerPath}`,
  ].join(' && ')
  const launchBody = `${fileWrites} && nohup bash ${innerPath} >/dev/null 2>&1 & echo bootstrap-launched`
  const outerScript = `bash -c '${launchBody}'`

  return {
    script: outerScript,
    doneMarkerPath: DONE_MARKER,
    progressLogPath: PROGRESS_LOG,
  }
}

export const BOOTSTRAP_DONE_MARKER = DONE_MARKER
export const BOOTSTRAP_FAIL_MARKER = FAIL_MARKER
export const BOOTSTRAP_PROGRESS_LOG = PROGRESS_LOG
export const BOOTSTRAP_SUCCESS_MARKER_PREFIX = 'anima-harness-pid='

/**
 * The exact strings the inner subshell writes to FAIL_MARKER on each step
 * failure. Kept in sync with the per-step `echo "X-failed"` calls inside
 * `buildBootstrapScript`. Pollers compare via substring match (the marker
 * file may also contain bash setlocale warnings).
 */
export const BOOTSTRAP_FAIL_KEYWORDS = [
  'apt-update-failed',
  'apt-install-failed',
  'bun-install-failed',
  'git-clone-failed',
  'harness-died-early',
] as const
