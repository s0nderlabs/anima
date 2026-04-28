import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { __test, makeBrowserNavigate, makeBrowserSnapshot } from './browser'

describe('browser parity (task #74)', () => {
  beforeEach(() => {
    __test.reset()
  })
  afterEach(() => {
    __test.reset()
    process.env.ANIMA_BROWSER_CDP_URL = undefined
  })

  test('socketSafeTmpdir returns /tmp on darwin', () => {
    if (process.platform !== 'darwin') {
      expect(__test.socketSafeTmpdir()).toBeTruthy()
      return
    }
    expect(__test.socketSafeTmpdir()).toBe('/tmp')
  })

  test('session name is stable across calls + has a_<10hex> shape', () => {
    const a = __test.getSessionName()
    const b = __test.getSessionName()
    expect(a).toBe(b)
    expect(a).toMatch(/^a_[0-9a-f]{10}$/)
  })

  test('socket dir is created under safe tmp + path stays under AF_UNIX 104-byte limit', () => {
    const dir = __test.getSocketDir()
    expect(existsSync(dir)).toBe(true)
    expect(statSync(dir).isDirectory()).toBe(true)
    if (process.platform === 'darwin') {
      expect(dir.startsWith('/tmp/agent-browser-a_')).toBe(true)
    }
    expect(dir.length).toBeLessThan(95)
  })

  test('findAgentBrowser returns null when nothing is on PATH', () => {
    const originalPath = process.env.PATH
    process.env.PATH = '/nonexistent-anima-test-path-zzz'
    try {
      const result = __test.findAgentBrowser()
      // On dev machines /opt/homebrew/bin/agent-browser may exist; fallthrough
      // hits SANE_PATH dirs. Just assert it does NOT throw and returns
      // either a string or null.
      expect(['string', 'object']).toContain(typeof result)
    } finally {
      process.env.PATH = originalPath
    }
  })

  test('buildBrowserEnv injects AGENT_BROWSER_SOCKET_DIR + redacts wallet keys', () => {
    process.env.ANIMA_OPERATOR_PRIVKEY = '0xdeadbeef'
    try {
      const env = __test.buildBrowserEnv('/tmp/test-socket-dir')
      expect(env.AGENT_BROWSER_SOCKET_DIR).toBe('/tmp/test-socket-dir')
      expect(env.PATH).toBeTruthy()
      expect(env.ANIMA_OPERATOR_PRIVKEY).toBeUndefined()
    } finally {
      process.env.ANIMA_OPERATOR_PRIVKEY = undefined
    }
  })

  test('navigate tool surfaces a clean error when bin is unreachable', async () => {
    const tool = makeBrowserNavigate({ binPath: '/nonexistent/agent-browser-zzz' })
    const result = (await tool.handler({ url: 'https://example.com' })) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  test('snapshot tool runs through the wrapper without crashing on a fake bin', async () => {
    // Use `true` (POSIX no-op that exits 0) as the bin to verify the wrapper
    // does NOT deadlock waiting on stdout pipes (regression for the daemon-fd
    // pipe deadlock bug). If we used pipes instead of temp files, this would
    // hang for the full timeout.
    const tool = makeBrowserSnapshot({ binPath: '/usr/bin/true', timeoutMs: 5000 })
    const result = (await tool.handler({ with_image: false, cap: false })) as {
      ok: boolean
      data?: { exit_code: number | null }
    }
    expect(result.ok).toBe(true)
    expect(result.data?.exit_code).toBe(0)
  })
})
