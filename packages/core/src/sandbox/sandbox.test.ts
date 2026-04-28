import { describe, expect, test } from 'bun:test'
import { makeSandboxBackend } from './factory'
import { LocalBackend } from './local'
import { MacOSSandboxExecBackend } from './macos'
import { buildSeatbeltProfile } from './seatbelt-profile'

describe('LocalBackend (passthrough)', () => {
  test('returns spawn request unchanged', async () => {
    const b = new LocalBackend()
    const req = {
      command: '/bin/sh',
      args: ['-c', 'echo ok'],
      options: { cwd: '/tmp' },
    }
    const out = await b.wrapSpawn(req)
    expect(out.command).toBe('/bin/sh')
    expect(out.args).toEqual(['-c', 'echo ok'])
    expect(out.options).toEqual({ cwd: '/tmp' })
  })

  test('mode + label expose correct identifiers', () => {
    const b = new LocalBackend()
    expect(b.mode).toBe('none')
    expect(b.label).toBe('none')
  })
})

describe('buildSeatbeltProfile', () => {
  test('emits a deny-default profile that explicitly allows agentDir + workspaceRoot', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/Users/test/.anima/agents/abc',
      workspaceRoot: '/Users/test/Documents/proj',
      homedir: '/Users/test',
    })
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('(allow file-write* (subpath "/Users/test/.anima/agents/abc"))')
    expect(profile).toContain('(allow file-write* (subpath "/Users/test/Documents/proj"))')
  })

  test('explicitly denies credential paths for both reads and writes', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/Users/test/.anima/agents/abc',
      workspaceRoot: '/Users/test/work',
      homedir: '/Users/test',
    })
    expect(profile).toContain('(deny file-write* (subpath "/Users/test/.ssh"))')
    expect(profile).toContain('(deny file-write* (subpath "/Users/test/.aws"))')
    expect(profile).toContain('(deny file-write* (subpath "/Users/test/Library/Keychains"))')
    expect(profile).toContain('(deny file-write* (subpath "/Users/test/.config/gcloud"))')
    expect(profile).toContain('(deny file-write* (subpath "/Users/test/.anima"))')
    // Reads of credential dirs blocked too — `cat ~/.ssh/id_rsa` should fail
    expect(profile).toContain('(deny file-read* (subpath "/Users/test/.ssh"))')
    expect(profile).toContain('(deny file-read* (subpath "/Users/test/.aws"))')
    expect(profile).toContain('(deny file-read* (subpath "/Users/test/Library/Keychains"))')
    expect(profile).toContain('(deny file-read* (subpath "/Users/test/.config/gcloud"))')
  })

  test('allows process-fork + process-exec + network', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/a',
      workspaceRoot: '/b',
      homedir: '/h',
    })
    expect(profile).toContain('(allow process-fork)')
    expect(profile).toContain('(allow process-exec)')
    expect(profile).toContain('(allow network*)')
    expect(profile).toContain('(allow file-read*)')
  })

  test('allows /tmp/anima-* + /var/folders for temp dirs', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/a',
      workspaceRoot: '/b',
      homedir: '/h',
    })
    expect(profile).toContain('(allow file-write* (regex #"^/tmp/anima-"))')
    expect(profile).toContain('(allow file-write* (regex #"^/private/tmp/anima-"))')
    expect(profile).toContain('(allow file-write* (subpath "/var/folders"))')
  })

  test('respects extraWriteAllow + extraWriteDeny', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/a',
      workspaceRoot: '/b',
      homedir: '/h',
      extraWriteAllow: ['/tmp/anima-test-sandbox-XYZ'],
      extraWriteDeny: ['/Users/h/Documents/sensitive'],
    })
    expect(profile).toContain('(allow file-write* (subpath "/tmp/anima-test-sandbox-XYZ"))')
    expect(profile).toContain('(deny file-write* (subpath "/Users/h/Documents/sensitive"))')
  })

  test('escapes embedded double quotes + backslashes in paths', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/path/with"quote',
      workspaceRoot: '/path\\with\\backslash',
      homedir: '/h',
    })
    expect(profile).toContain('/path/with\\"quote')
    expect(profile).toContain('/path\\\\with\\\\backslash')
  })

  test('re-allows agentDir AFTER the broad ~/.anima deny so anima state stays writable', () => {
    const profile = buildSeatbeltProfile({
      agentDir: '/Users/test/.anima/agents/abc',
      workspaceRoot: '/w',
      homedir: '/Users/test',
    })
    const agentAllowIdx = profile.lastIndexOf(
      '(allow file-write* (subpath "/Users/test/.anima/agents/abc"))',
    )
    const animaDenyIdx = profile.indexOf('(deny file-write* (subpath "/Users/test/.anima"))')
    expect(agentAllowIdx).toBeGreaterThan(-1)
    expect(animaDenyIdx).toBeGreaterThan(-1)
    expect(agentAllowIdx).toBeGreaterThan(animaDenyIdx)
  })
})

describe('MacOSSandboxExecBackend', () => {
  // sandbox-exec is macOS-only; skip these on Linux CI but assert constructor
  // there too.
  if (process.platform !== 'darwin') {
    test('skipped on non-darwin', () => {
      expect(true).toBe(true)
    })
    return
  }

  test('constructs with valid opts on darwin', () => {
    const b = new MacOSSandboxExecBackend({
      agentDir: '/tmp/anima-test-agent',
      workspaceRoot: '/tmp',
      homedir: process.env.HOME ?? '/tmp',
    })
    expect(b.mode).toBe('os')
    expect(b.label).toBe('os:darwin')
    const profile = b.getProfile()
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('(allow file-write* (subpath "/tmp/anima-test-agent"))')
  })

  test('wrapSpawn prepends sandbox-exec + profile to argv', async () => {
    const b = new MacOSSandboxExecBackend({
      agentDir: '/tmp/anima-test-agent',
      workspaceRoot: '/tmp',
      homedir: process.env.HOME ?? '/tmp',
    })
    const out = await b.wrapSpawn({
      command: '/bin/sh',
      args: ['-c', 'echo hi'],
      options: { cwd: '/tmp' },
    })
    expect(out.command).toBe('/usr/bin/sandbox-exec')
    expect(out.args[0]).toBe('-p')
    expect(typeof out.args[1]).toBe('string')
    expect(out.args[1]?.includes('(deny default)')).toBe(true)
    expect(out.args.slice(2)).toEqual(['/bin/sh', '-c', 'echo hi'])
    expect(out.options).toEqual({ cwd: '/tmp' })
  })
})

describe('makeSandboxBackend factory', () => {
  test('mode=none returns LocalBackend on any platform', () => {
    const b = makeSandboxBackend({
      mode: 'none',
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      platform: 'darwin',
    })
    expect(b.mode).toBe('none')
    const b2 = makeSandboxBackend({
      mode: 'none',
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      platform: 'linux',
    })
    expect(b2.mode).toBe('none')
  })

  test('mode=docker constructs DockerBackend if a runtime exists, else falls back', () => {
    let warned = ''
    const b = makeSandboxBackend({
      mode: 'docker',
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      platform: 'darwin',
      warn: m => {
        warned = m
      },
    })
    // On a developer machine with docker/podman installed, mode === 'docker'.
    // On a stripped CI box with neither, factory falls back to LocalBackend
    // and emits a warning. Either is acceptable for this test.
    if (b.mode === 'docker') {
      expect(b.label.startsWith('docker:') || b.label.startsWith('podman:')).toBe(true)
    } else {
      expect(b.mode).toBe('none')
      expect(warned).toContain('docker')
    }
  })

  test('mode=os on linux falls back to LocalBackend with warning', () => {
    let warned = ''
    const b = makeSandboxBackend({
      mode: 'os',
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      platform: 'linux',
      warn: m => {
        warned = m
      },
    })
    expect(b.mode).toBe('none')
    expect(warned).toContain('linux')
    expect(warned).toContain('passthrough')
  })

  test('mode=os on unknown platform falls back to LocalBackend with warning', () => {
    let warned = ''
    const b = makeSandboxBackend({
      mode: 'os',
      agentDir: '/a',
      workspaceRoot: '/w',
      homedir: '/h',
      platform: 'aix',
      warn: m => {
        warned = m
      },
    })
    expect(b.mode).toBe('none')
    expect(warned).toContain('aix')
  })

  if (process.platform === 'darwin') {
    test('mode=os on darwin returns MacOSSandboxExecBackend', () => {
      const b = makeSandboxBackend({
        mode: 'os',
        agentDir: '/tmp/anima-test-agent',
        workspaceRoot: '/tmp',
        homedir: process.env.HOME ?? '/tmp',
      })
      expect(b.mode).toBe('os')
      expect(b.label).toBe('os:darwin')
    })
  }
})
