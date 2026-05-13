import { describe, expect, it } from 'bun:test'
import type {
  SandboxProviderClient,
  ToolboxExecBody,
  ToolboxExecResponse,
} from '@s0nderlabs/anima-core'
import { parseUpgradeArgs, probeContainerBootstrapMode } from './upgrade'

// Minimal mock for SandboxProviderClient that lets us assert what `command`
// got sent to execInToolbox and stub the response. v0.21.19 added this to
// verify the bash -c wrap fix that closes Bug 2 in
// feedback-reprovision-skips-tg-and-probe-bug.
function makeMockProvider(respond: (cmd: string) => ToolboxExecResponse | Error): {
  provider: SandboxProviderClient
  lastCommand: { value: string | null }
} {
  const lastCommand: { value: string | null } = { value: null }
  const provider = {
    async execInToolbox(_id: string, body: ToolboxExecBody): Promise<ToolboxExecResponse> {
      lastCommand.value = body.command
      const r = respond(body.command)
      if (r instanceof Error) throw r
      return r
    },
  } as unknown as SandboxProviderClient
  return { provider, lastCommand }
}

describe('parseUpgradeArgs', () => {
  it('empty tail → no ref, no flags', () => {
    expect(parseUpgradeArgs([])).toEqual({
      ref: undefined,
      yes: false,
      reprovision: false,
    })
  })
  it('--yes alone → no ref', () => {
    expect(parseUpgradeArgs(['--yes'])).toEqual({
      ref: undefined,
      yes: true,
      reprovision: false,
    })
  })
  it('positional `latest`', () => {
    expect(parseUpgradeArgs(['latest'])).toEqual({
      ref: 'latest',
      yes: false,
      reprovision: false,
    })
  })
  it('positional tag `v0.17.8`', () => {
    expect(parseUpgradeArgs(['v0.17.8'])).toEqual({
      ref: 'v0.17.8',
      yes: false,
      reprovision: false,
    })
  })
  it('positional + --yes', () => {
    expect(parseUpgradeArgs(['latest', '--yes'])).toEqual({
      ref: 'latest',
      yes: true,
      reprovision: false,
    })
  })
  it('--ref takes priority over positional', () => {
    expect(parseUpgradeArgs(['main', '--ref', 'v0.17.8'])).toEqual({
      ref: 'v0.17.8',
      yes: false,
      reprovision: false,
    })
  })
  it('--ref + --yes', () => {
    expect(parseUpgradeArgs(['--ref', 'v0.17.8', '--yes'])).toEqual({
      ref: 'v0.17.8',
      yes: true,
      reprovision: false,
    })
  })
  it('--reprovision flag captured', () => {
    expect(parseUpgradeArgs(['v0.17.8', '--reprovision', '--yes'])).toEqual({
      ref: 'v0.17.8',
      yes: true,
      reprovision: true,
    })
  })
  it('-y short alias works', () => {
    expect(parseUpgradeArgs(['-y'])).toEqual({
      ref: undefined,
      yes: true,
      reprovision: false,
    })
  })
})

describe('probeContainerBootstrapMode (bash -c wrap fix)', () => {
  // Daytona's execInToolbox endpoint runs `command` argv-style — no shell
  // interpretation. Bare `if [ ... ]; ...; fi` gets tokenised and `if`
  // becomes argv[0]. v0.21.19 wraps the probe in `bash -c '<inner>'` so
  // the inner shell handles the conditional. These tests assert both the
  // command shape (regression-proof against a future un-wrap) AND the
  // three response-parsing branches.

  it('sends a bash -c wrapped command', async () => {
    const { provider, lastCommand } = makeMockProvider(() => ({
      exitCode: 0,
      result: 'MODE=git\n',
    }))
    await probeContainerBootstrapMode(provider, 'sbx-test')
    expect(lastCommand.value).not.toBeNull()
    expect(lastCommand.value!.startsWith(`bash -c '`)).toBe(true)
    expect(lastCommand.value!).toContain('if [ -d "$HOME/anima/.git" ]')
    expect(lastCommand.value!).toContain('echo MODE=git')
    expect(lastCommand.value!).toContain('echo MODE=npm')
    expect(lastCommand.value!).toContain('echo MODE=none')
    expect(lastCommand.value!.endsWith(`fi'`)).toBe(true)
  })

  it('returns "git" when stdout contains MODE=git', async () => {
    const { provider } = makeMockProvider(() => ({ exitCode: 0, result: 'MODE=git\n' }))
    expect(await probeContainerBootstrapMode(provider, 'sbx-test')).toBe('git')
  })

  it('returns "npm" when stdout contains MODE=npm', async () => {
    const { provider } = makeMockProvider(() => ({ exitCode: 0, result: 'MODE=npm\n' }))
    expect(await probeContainerBootstrapMode(provider, 'sbx-test')).toBe('npm')
  })

  it('returns null when stdout contains MODE=none', async () => {
    const { provider } = makeMockProvider(() => ({ exitCode: 0, result: 'MODE=none\n' }))
    expect(await probeContainerBootstrapMode(provider, 'sbx-test')).toBeNull()
  })

  it('returns null when exec throws (swallows network/auth errors)', async () => {
    const { provider } = makeMockProvider(() => new Error('toolbox 500 internal'))
    expect(await probeContainerBootstrapMode(provider, 'sbx-test')).toBeNull()
  })
})
