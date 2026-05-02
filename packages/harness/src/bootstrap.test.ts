import { describe, expect, test } from 'bun:test'
import {
  BOOTSTRAP_DONE_MARKER,
  BOOTSTRAP_FAIL_MARKER,
  BOOTSTRAP_PROGRESS_LOG,
  BOOTSTRAP_SUCCESS_MARKER_PREFIX,
  buildBootstrapScript,
} from './bootstrap'

describe('buildBootstrapScript', () => {
  const baseOpts = {
    sandboxId: 'sbx-abc-123',
    operatorAddress: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
    ref: 'v0.15.0',
  }

  test('outer wrapper is `bash -c` with base64 inner; no shell metachars in payload', () => {
    const { script, doneMarkerPath, progressLogPath } = buildBootstrapScript(baseOpts)
    expect(script.startsWith("bash -c '")).toBe(true)
    expect(script.endsWith("'")).toBe(true)
    expect(script).toContain('base64 -d')
    expect(script).toContain('nohup bash /tmp/anima-bootstrap-inner.sh')
    expect(script).toContain('echo bootstrap-launched')
    expect(doneMarkerPath).toBe(BOOTSTRAP_DONE_MARKER)
    expect(progressLogPath).toBe(BOOTSTRAP_PROGRESS_LOG)
    // The outer payload (between the bash -c quotes) must not contain nested
    // single quotes that would prematurely close the wrapper.
    const inside = script.slice("bash -c '".length, -1)
    expect(inside).not.toContain("'")
    // Exactly one `echo BASE64 | base64 -d` pipe in the launch body.
    expect(inside.split(' | ').length).toBe(2)
  })

  test('inner subshell (base64-decoded) carries apt + bun + git + harness launch', () => {
    const { script } = buildBootstrapScript(baseOpts)
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    expect(m).not.toBeNull()
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(inner).toContain('sudo -n apt-get update -qq')
    expect(inner).toMatch(/sudo -n apt-get install -y -qq .*chromium/)
    expect(inner).toContain('curl -fsSL https://bun.sh/install')
    expect(inner).toContain('git clone --depth 1 --branch')
    expect(inner).toContain('bun install --frozen-lockfile')
    // Harness clones to $HOME/anima (daytona user has no /opt write perm).
    expect(inner).toContain('nohup bun "$ANIMA_DIR/packages/harness/bin/anima-harness"')
    expect(inner).toContain(`echo "anima-harness-pid=$HARNESS_PID" > ${BOOTSTRAP_DONE_MARKER}`)
  })

  test('frees port 8080 via fuser before harness launch (Daytona snapshot guard)', () => {
    const { script } = buildBootstrapScript(baseOpts)
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    // Pre-launch port kill (defensive against pre-existing service in snapshot)
    expect(inner).toContain('[free port 8080]')
    expect(inner).toContain('fuser -k 8080/tcp 2>/dev/null || true')
    // Per-attempt port kill (defensive against zombie bun from a prior attempt)
    expect(inner.match(/fuser -k 8080\/tcp/g)?.length).toBeGreaterThanOrEqual(2)
    // psmisc apt package required for fuser
    expect(inner).toMatch(/sudo -n apt-get install .* psmisc/)
  })

  test('honors custom port — port-kill uses the same port', () => {
    const { script } = buildBootstrapScript({ ...baseOpts, port: 9090 })
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(inner).toContain('[free port 9090]')
    expect(inner).toContain('fuser -k 9090/tcp 2>/dev/null || true')
  })

  test('harness launch has 3-attempt retry with 10s startup wait (bun cold-start jitter)', () => {
    const { script } = buildBootstrapScript(baseOpts)
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(inner).toContain('for h_attempt in 1 2 3; do')
    expect(inner).toContain('HARNESS_OK=0')
    expect(inner).toContain('HARNESS_OK=1')
    expect(inner).toContain('[harness launch attempt $h_attempt/3]')
    // Initial wait bumped from 3s to 10s to absorb bun cold-start jitter on
    // Daytona containers. Verified May 2 2026 oracle init.
    expect(inner).toMatch(/sleep 10[^\d]/)
    // 5s backoff between attempts.
    expect(inner).toMatch(/\[retrying in 5s\][\s\S]*sleep 5/)
    // Failure marker still written if all 3 fail.
    expect(inner).toContain('if [ "$HARNESS_OK" -ne 1 ]; then')
    expect(inner).toContain('echo "harness-died-early" >')
  })

  test('git clone has 3-attempt retry-with-backoff (transient github 429/DNS resilience)', () => {
    const { script } = buildBootstrapScript(baseOpts)
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(inner).toContain('for attempt in 1 2 3; do')
    expect(inner).toContain('GIT_CLONE_OK=0')
    expect(inner).toContain('GIT_CLONE_OK=1')
    expect(inner).toContain('BACKOFF=$((attempt * 5))')
    expect(inner).toContain('retrying in ${BACKOFF}s')
    // Workspace dir is wiped between retries so partial clone state can't poison
    // the next attempt.
    expect(inner).toMatch(/sleep \$BACKOFF/)
    // Failure marker still written if all 3 fail.
    expect(inner).toContain('if [ "$GIT_CLONE_OK" -ne 1 ]; then echo "git-clone-failed" >')
  })

  test('inner subshell writes fail marker on each step failure', () => {
    const { script } = buildBootstrapScript(baseOpts)
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(inner).toContain('apt-update-failed')
    expect(inner).toContain('apt-install-failed')
    expect(inner).toContain('bun-install-failed')
    expect(inner).toContain('git-clone-failed')
    expect(inner).toContain('harness-died-early')
    expect(inner).toContain(BOOTSTRAP_FAIL_MARKER)
  })

  test('embeds the requested ref + repo url + sandbox id + operator', () => {
    const { script } = buildBootstrapScript({ ...baseOpts, repoUrl: 'https://x.test/foo.git' })
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(inner).toContain("'https://x.test/foo.git'")
    expect(inner).toContain("'v0.15.0'")
    expect(inner).toContain("export SANDBOX_ID='sbx-abc-123'")
    expect(inner).toContain(
      "export ANIMA_OPERATOR_ADDRESS='0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec'",
    )
  })

  test('honors custom port', () => {
    const { script } = buildBootstrapScript({ ...baseOpts, port: 9090 })
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(inner).toContain("export HARNESS_PORT='9090'")
  })

  test('apt list defaults include chromium + xvfb + git', () => {
    const { script } = buildBootstrapScript(baseOpts)
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(inner).toMatch(/sudo -n apt-get install .* chromium/)
    expect(inner).toMatch(/sudo -n apt-get install .* xvfb/)
    expect(inner).toMatch(/sudo -n apt-get install .* git/)
  })

  test('extra apt packages are appended and deduped', () => {
    const { script } = buildBootstrapScript({
      ...baseOpts,
      extraAptPackages: ['ffmpeg', 'chromium'],
    })
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    const aptLine = inner.split('\n').find(l => l.includes('apt-get install -y -qq'))!
    expect(aptLine).toContain('ffmpeg')
    const chromiumCount = (aptLine.match(/chromium/g) ?? []).length
    expect(chromiumCount).toBe(1)
  })

  test('shell-quotes injection-prone fields safely', () => {
    const { script } = buildBootstrapScript({
      ...baseOpts,
      sandboxId: "abc'; rm -rf /; echo '",
    })
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(inner).toContain("export SANDBOX_ID='abc'\\''; rm -rf /; echo '\\'''")
  })

  test('exposes BOOTSTRAP_SUCCESS_MARKER_PREFIX for callers that grep done file', () => {
    expect(BOOTSTRAP_SUCCESS_MARKER_PREFIX).toBe('anima-harness-pid=')
  })

  test('clones to $HOME/anima (not /opt/anima — daytona user has no sudo for /opt)', () => {
    const { script } = buildBootstrapScript(baseOpts)
    const m = script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d/)
    const inner = Buffer.from(m![1]!, 'base64').toString('utf8')
    expect(inner).toContain('ANIMA_DIR="$HOME/anima"')
    expect(inner).not.toContain('/opt/anima')
    expect(inner).toContain('rm -rf "$ANIMA_DIR"')
  })
})
