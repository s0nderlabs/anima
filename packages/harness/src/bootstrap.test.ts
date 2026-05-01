import { describe, expect, test } from 'bun:test'
import { BOOTSTRAP_SUCCESS_MARKER_PREFIX, buildBootstrapScript } from './bootstrap'

describe('buildBootstrapScript', () => {
  const baseOpts = {
    sandboxId: 'sbx-abc-123',
    operatorAddress: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec',
    ref: 'v0.15.0',
  }

  test('shape: shebang + set -euo pipefail + success-marker echo', () => {
    const { script, successMarker } = buildBootstrapScript(baseOpts)
    expect(script.startsWith('#!/bin/bash\n')).toBe(true)
    expect(script).toContain('set -euo pipefail')
    expect(successMarker).toBe(`${BOOTSTRAP_SUCCESS_MARKER_PREFIX}<pid>`)
    expect(script).toContain('echo "anima-harness-pid=$HARNESS_PID"')
  })

  test('embeds the requested ref + repo url', () => {
    const { script } = buildBootstrapScript({ ...baseOpts, repoUrl: 'https://x.test/foo.git' })
    expect(script).toContain("'https://x.test/foo.git'")
    expect(script).toContain("'v0.15.0'")
    expect(script).toContain('git clone --depth 1 --branch')
    expect(script).toContain('git fetch --depth 1 origin')
  })

  test('passes sandbox id and operator address as env exports', () => {
    const { script } = buildBootstrapScript(baseOpts)
    expect(script).toContain("export SANDBOX_ID='sbx-abc-123'")
    expect(script).toContain(
      "export ANIMA_OPERATOR_ADDRESS='0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec'",
    )
    expect(script).toContain("export HARNESS_PORT='8080'")
    expect(script).toContain("export HARNESS_HOST='0.0.0.0'")
  })

  test('honors custom port', () => {
    const { script } = buildBootstrapScript({ ...baseOpts, port: 9090 })
    expect(script).toContain("export HARNESS_PORT='9090'")
  })

  test('apt list contains chromium + xvfb + git defaults', () => {
    const { script } = buildBootstrapScript(baseOpts)
    expect(script).toMatch(/apt-get install .* chromium/)
    expect(script).toMatch(/apt-get install .* xvfb/)
    expect(script).toMatch(/apt-get install .* git/)
  })

  test('extra apt packages are appended and deduped', () => {
    const { script } = buildBootstrapScript({
      ...baseOpts,
      extraAptPackages: ['ffmpeg', 'chromium'], // duplicate of default
    })
    const aptLine = script.split('\n').find(l => l.includes('apt-get install -y -qq'))!
    expect(aptLine).toContain('ffmpeg')
    // chromium appears once (dedupe)
    const chromiumCount = (aptLine.match(/chromium/g) ?? []).length
    expect(chromiumCount).toBe(1)
  })

  test('shell-quotes injection-prone fields', () => {
    // pathological sandbox id with single quotes — should still quote-escape safely
    const { script } = buildBootstrapScript({
      ...baseOpts,
      sandboxId: "abc'; rm -rf /; echo '",
    })
    // The dangerous payload must be inside a single-quoted shell literal where
    // its `'` is escaped. The literal opens with `'` and any `'` inside is
    // converted to `'\''`. So the quote sequence appears intact in the output.
    expect(script).toContain("export SANDBOX_ID='abc'\\''; rm -rf /; echo '\\'''")
    // Bash will parse this back to the original string when expanded.
  })

  test('starts harness with nohup and checks pid liveness', () => {
    const { script } = buildBootstrapScript(baseOpts)
    expect(script).toContain('nohup bun /opt/anima/packages/harness/bin/anima-harness')
    expect(script).toContain('disown')
    expect(script).toContain('HARNESS_PID=$!')
    expect(script).toContain('kill -0 "$HARNESS_PID"')
  })
})
