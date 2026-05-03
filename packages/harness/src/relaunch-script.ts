/**
 * Builds the bash script the CLI runs via `provider.execInToolbox` after
 * Daytona restores an archived sandbox. The container filesystem is intact
 * (preserved across archive→restore) but every process inside the container
 * was terminated when archive happened. The harness daemon needs to be
 * relaunched.
 *
 * This is a SLIMMED version of `buildBootstrapScript`: no apt-get, no git
 * clone, no `bun install`. Just env-export + fuser-kill + nohup launch +
 * 10s wait for kill -0 to confirm the daemon is alive.
 *
 * Returns a single base64-wrapped `bash -c '...'` invocation (under
 * Daytona's 6KB execInToolbox payload cap).
 */
export interface BuildRelaunchScriptOpts {
  sandboxId: string
  operatorAddress: string
  port?: number
  /**
   * Optional override of the heartbeat interval inside the relaunched harness.
   * Pass milliseconds; falls through to the harness's default (30 min) if
   * unset. Used by canary scripts to compress verification windows.
   */
  heartbeatIntervalMs?: number
}

export interface BuildRelaunchScriptResult {
  /** Single-line bash -c invocation safe to pass to execInToolbox. */
  script: string
  /** File the caller can tail to read relaunch progress. */
  progressLogPath: string
  /** File written when relaunch succeeds (line: `anima-harness-pid=<N>`). */
  doneMarkerPath: string
  /** File written when relaunch fails. Body contains a short failure keyword. */
  failMarkerPath: string
}

const PROGRESS_LOG = '/tmp/anima-relaunch-progress.log'
const DONE_MARKER = '/tmp/anima-relaunch-done'
const FAIL_MARKER = '/tmp/anima-relaunch-failed'

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export function buildHarnessRelaunchScript(
  opts: BuildRelaunchScriptOpts,
): BuildRelaunchScriptResult {
  const port = opts.port ?? 8080
  const env: string[] = [
    `export SANDBOX_ID=${shQuote(opts.sandboxId)}`,
    `export ANIMA_OPERATOR_ADDRESS=${shQuote(opts.operatorAddress)}`,
    `export HARNESS_PORT=${shQuote(String(port))}`,
    "export HARNESS_HOST='0.0.0.0'",
    'export PATH="$HOME/.bun/bin:$PATH"',
  ]
  if (typeof opts.heartbeatIntervalMs === 'number' && opts.heartbeatIntervalMs > 0) {
    env.push(`export HARNESS_HEARTBEAT_INTERVAL_MS=${shQuote(String(opts.heartbeatIntervalMs))}`)
  }

  const inner = [
    'set -u',
    'mkdir -p "$HOME/anima-logs"',
    `rm -f ${DONE_MARKER} ${FAIL_MARKER} ${PROGRESS_LOG}`,
    `exec > >(tee -a ${PROGRESS_LOG}) 2>&1`,
    'echo "[$(date -u +%FT%TZ)] relaunch-start"',
    'ANIMA_DIR="$HOME/anima"',
    'if [ ! -d "$ANIMA_DIR" ]; then',
    `  echo "anima-dir-missing" > ${FAIL_MARKER}`,
    '  echo "[fail] $ANIMA_DIR not found; sandbox snapshot may have been wiped"',
    '  exit 21',
    'fi',
    ...env,
    `fuser -k ${port}/tcp 2>/dev/null || true`,
    'sleep 2',
    'echo "[launch harness daemon]"',
    'HARNESS_PID=""',
    'HARNESS_OK=0',
    'for h_attempt in 1 2 3; do',
    '  echo "[launch attempt $h_attempt/3]"',
    `  fuser -k ${port}/tcp 2>/dev/null || true`,
    '  sleep 1',
    '  nohup bun "$ANIMA_DIR/packages/harness/bin/anima-harness" > "$HOME/anima-logs/anima-harness.log" 2>&1 &',
    '  HARNESS_PID=$!',
    '  disown',
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
    '  exit 22',
    'fi',
    `echo "anima-harness-pid=$HARNESS_PID" > ${DONE_MARKER}`,
    'echo "[$(date -u +%FT%TZ)] relaunch-done pid=$HARNESS_PID"',
  ].join('\n')

  // base64-wrapped bash -c so Daytona's argv-only execInToolbox handles it.
  // Note the trailing `& echo` (NOT `& && echo`): `&` is the background operator
  // that fires-and-continues; `&&` after it would be a syntax error.
  const innerB64 = Buffer.from(inner, 'utf8').toString('base64')
  const innerPath = '/tmp/anima-relaunch-inner.sh'
  const fileWrites = `echo ${shQuote(innerB64)} | base64 -d > ${innerPath} && chmod +x ${innerPath}`
  const launchBody = `${fileWrites} && nohup bash ${innerPath} >/dev/null 2>&1 & echo relaunch-launched`

  return {
    script: `bash -c '${launchBody}'`,
    progressLogPath: PROGRESS_LOG,
    doneMarkerPath: DONE_MARKER,
    failMarkerPath: FAIL_MARKER,
  }
}

export const RELAUNCH_DONE_MARKER = DONE_MARKER
export const RELAUNCH_FAIL_MARKER = FAIL_MARKER
export const RELAUNCH_PROGRESS_LOG = PROGRESS_LOG
export const RELAUNCH_SUCCESS_MARKER_PREFIX = 'anima-harness-pid='
