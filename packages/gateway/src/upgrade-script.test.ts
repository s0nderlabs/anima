import { describe, expect, test } from 'bun:test'
import {
  UPGRADE_DONE_MARKER,
  UPGRADE_FAIL_MARKER,
  UPGRADE_PROGRESS_LOG,
  UPGRADE_SUCCESS_MARKER_PREFIX,
  buildUpgradeScript,
} from './upgrade-script'

describe('buildUpgradeScript', () => {
  const baseOpts = {
    sandboxId: 'sbx-abc-123',
    operatorAddress: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
    ref: 'v0.17.0',
  }

  // Decodes the base64-baked inner subshell out of the outer `bash -c '...'`
  // wrapper. Most tests assert on the inner script's bash semantics.
  const decodeInner = (opts: Parameters<typeof buildUpgradeScript>[0] = baseOpts): string => {
    const { script } = buildUpgradeScript(opts)
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    return Buffer.from(m![1]!, 'base64').toString('utf8')
  }

  test('outer wrapper is `bash -c` with base64 inner; no shell metachars in payload', () => {
    const { script, doneMarkerPath, progressLogPath } = buildUpgradeScript(baseOpts)
    expect(script.startsWith("bash -c '")).toBe(true)
    expect(script.endsWith("'")).toBe(true)
    expect(script).toContain('base64 -d')
    expect(script).toContain('nohup bash /tmp/anima-upgrade-inner.sh')
    expect(script).toContain('echo upgrade-launched')
    expect(doneMarkerPath).toBe(UPGRADE_DONE_MARKER)
    expect(progressLogPath).toBe(UPGRADE_PROGRESS_LOG)
    // Outer payload must contain no nested single-quotes.
    const inside = script.slice("bash -c '".length, -1)
    expect(inside).not.toContain("'")
    // Exactly one `echo BASE64 | base64 -d` pipe in launch body.
    expect(inside.split(' | ').length).toBe(2)
  })

  test('inner subshell carries git fetch + checkout + bun install + harness restart', () => {
    const inner = decodeInner()
    expect(inner).toContain('cd "$HOME/anima"')
    expect(inner).toContain('git fetch --tags --depth 50 origin')
    expect(inner).toContain(`git checkout '${baseOpts.ref}'`)
    expect(inner).toContain('bun install --frozen-lockfile')
    expect(inner).toContain('pkill -f anima-gateway')
    expect(inner).toContain('nohup bun "$HOME/anima/packages/gateway/bin/anima-gateway"')
    expect(inner).toContain(`echo "anima-gateway-pid=$HARNESS_PID" > ${UPGRADE_DONE_MARKER}`)
  })

  test('inner subshell does NOT do bootstrap-only steps (apt / clone / bun-binary)', () => {
    const inner = decodeInner()
    expect(inner).not.toContain('apt-get')
    expect(inner).not.toContain('git clone')
    expect(inner).not.toContain('bun.sh/install')
  })

  test('exposes a generic retry() shell function with 3-attempt linear backoff', () => {
    const inner = decodeInner()
    expect(inner).toContain('retry() {')
    expect(inner).toContain('for n in 1 2 3; do')
    expect(inner).toContain('"$@" && return 0')
    expect(inner).toContain('sleep $((n*5))')
  })

  test('git fetch is wrapped in retry()', () => {
    const inner = decodeInner()
    expect(inner).toMatch(
      /retry 'git fetch' git fetch --tags --depth 50 origin \|\| \{ echo "git-fetch-failed"/,
    )
  })

  test('git checkout is wrapped in retry()', () => {
    const inner = decodeInner()
    expect(inner).toMatch(
      /retry 'git checkout' git checkout '[^']+' \|\| \{ echo "git-checkout-failed"/,
    )
  })

  test('bun install is wrapped in retry()', () => {
    const inner = decodeInner()
    expect(inner).toMatch(
      /retry 'bun deps' bun install --frozen-lockfile \|\| \{ echo "bun-install-failed"/,
    )
  })

  test('frees port 8080 via fuser before AND on each launch attempt', () => {
    const inner = decodeInner()
    // Pre-launch + per-attempt port kill (defensive against zombie bun on rebind)
    expect(
      inner.match(/fuser -k 8080\/tcp 2>\/dev\/null \|\| true/g)?.length,
    ).toBeGreaterThanOrEqual(2)
  })

  test('honors custom port; port-kill uses the same port', () => {
    const inner = decodeInner({ ...baseOpts, port: 9090 })
    expect(inner).toContain('fuser -k 9090/tcp 2>/dev/null || true')
    expect(inner).not.toContain('fuser -k 8080/tcp')
  })

  test('harness launch has 3-attempt retry with 10s startup wait (mirror bootstrap)', () => {
    const inner = decodeInner()
    expect(inner).toContain('for h_attempt in 1 2 3; do')
    expect(inner).toContain('HARNESS_OK=0')
    expect(inner).toContain('HARNESS_OK=1')
    expect(inner).toContain('[launch attempt $h_attempt/3]')
    expect(inner).toMatch(/sleep 10[^\d]/)
    expect(inner).toMatch(/\[retrying in 5s\][\s\S]*sleep 5/)
    expect(inner).toContain('if [ "$HARNESS_OK" -ne 1 ]; then')
    expect(inner).toContain('echo "harness-died-early" >')
  })

  test('inner subshell writes fail marker on each step failure', () => {
    const inner = decodeInner()
    expect(inner).toContain('anima-dir-missing')
    expect(inner).toContain('git-fetch-failed')
    expect(inner).toContain('git-checkout-failed')
    expect(inner).toContain('bun-install-failed')
    expect(inner).toContain('harness-died-early')
    expect(inner).toContain(UPGRADE_FAIL_MARKER)
  })

  test('embeds the requested ref + repo url + sandbox id + operator address', () => {
    const inner = decodeInner({ ...baseOpts, repoUrl: 'https://x.test/foo.git' })
    expect(inner).toContain("'https://x.test/foo.git'")
    expect(inner).toContain(`'${baseOpts.ref}'`)
    expect(inner).toContain(`export SANDBOX_ID='${baseOpts.sandboxId}'`)
    expect(inner).toContain(`export ANIMA_OPERATOR_ADDRESS='${baseOpts.operatorAddress}'`)
  })

  test('honors custom port via env export', () => {
    const inner = decodeInner({ ...baseOpts, port: 9090 })
    expect(inner).toContain("export HARNESS_PORT='9090'")
  })

  test('exports the standard harness env vars (HARNESS_HOST, HARNESS_PORT, SANDBOX_ID, ANIMA_OPERATOR_ADDRESS)', () => {
    const inner = decodeInner()
    expect(inner).toContain("export HARNESS_HOST='0.0.0.0'")
    expect(inner).toContain("export HARNESS_PORT='8080'")
    expect(inner).toContain(`export SANDBOX_ID='${baseOpts.sandboxId}'`)
    expect(inner).toContain(`export ANIMA_OPERATOR_ADDRESS='${baseOpts.operatorAddress}'`)
  })

  test('shell-quotes injection-prone fields safely', () => {
    const inner = decodeInner({ ...baseOpts, sandboxId: "abc'; rm -rf /; echo '" })
    expect(inner).toContain("export SANDBOX_ID='abc'\\''; rm -rf /; echo '\\'''")
  })

  test('exposes UPGRADE_SUCCESS_MARKER_PREFIX matching bootstrap (callers grep done file)', () => {
    expect(UPGRADE_SUCCESS_MARKER_PREFIX).toBe('anima-gateway-pid=')
  })

  test('outer script stays under Daytona request-size ceiling (<5000 bytes)', () => {
    // Same regression guard as bootstrap.test.ts. v0.16.6 broke at 6136 bytes.
    // Upgrade is leaner than bootstrap so this should sit comfortably ~2300.
    const { script } = buildUpgradeScript(baseOpts)
    expect(script.length).toBeLessThan(5000)
  })

  test('uses $HOME/anima (matches bootstrap clone target; daytona user has no /opt sudo)', () => {
    const inner = decodeInner()
    expect(inner).toContain('cd "$HOME/anima"')
    expect(inner).not.toContain('/opt/anima')
  })

  test('idempotent on dirty working tree (git reset --hard before fetch)', () => {
    const inner = decodeInner()
    expect(inner).toContain('git reset --hard HEAD')
  })

  test('rewrites git remote URL before fetch (defends against stale credential helper)', () => {
    const inner = decodeInner()
    expect(inner).toContain('git remote set-url origin')
  })
})
