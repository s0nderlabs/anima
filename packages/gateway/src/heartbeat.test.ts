import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { startHeartbeat } from './heartbeat'

describe('startHeartbeat', () => {
  let envBackup: string | undefined

  beforeEach(() => {
    envBackup = process.env.SANDBOX_PUBLIC_URL
    Reflect.deleteProperty(process.env, 'SANDBOX_PUBLIC_URL')
  })

  afterEach(() => {
    if (envBackup === undefined) Reflect.deleteProperty(process.env, 'SANDBOX_PUBLIC_URL')
    else process.env.SANDBOX_PUBLIC_URL = envBackup
  })

  test('builds default URL from sandboxId via buildSandboxEndpoint', () => {
    const fetchImpl = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response('', { status: 200 })) as typeof fetch
    const hb = startHeartbeat({
      sandboxId: 'abc-123',
      fetchImpl,
      intervalMs: 60_000,
    })
    try {
      expect(hb.targetUrl()).toBe('http://8080-abc-123.43.106.147.28.nip.io:4000/healthz')
    } finally {
      hb.stop()
    }
  })

  test('SANDBOX_PUBLIC_URL env override takes precedence over default', () => {
    process.env.SANDBOX_PUBLIC_URL = 'http://env-override.test/healthz'
    const fetchImpl = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response('', { status: 200 })) as typeof fetch
    const hb = startHeartbeat({
      sandboxId: 'sb-x',
      fetchImpl,
      intervalMs: 60_000,
    })
    try {
      expect(hb.targetUrl()).toBe('http://env-override.test/healthz')
    } finally {
      hb.stop()
    }
  })

  test('explicit targetUrl wins over env and default', () => {
    process.env.SANDBOX_PUBLIC_URL = 'http://from-env.test/healthz'
    const fetchImpl = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response('', { status: 200 })) as typeof fetch
    const hb = startHeartbeat({
      sandboxId: 'sb-x',
      fetchImpl,
      intervalMs: 60_000,
      targetUrl: 'http://explicit.test/healthz',
    })
    try {
      expect(hb.targetUrl()).toBe('http://explicit.test/healthz')
    } finally {
      hb.stop()
    }
  })

  test('runOnce success: 2xx response increments successCount, logs ok', async () => {
    const logs: string[] = []
    let calls = 0
    const fetchImpl = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => {
      calls += 1
      return new Response('ok', { status: 200 })
    }) as typeof fetch
    const hb = startHeartbeat({
      sandboxId: 'sb-ok',
      fetchImpl,
      intervalMs: 60_000,
      logger: l => logs.push(l),
      targetUrl: 'http://ok.local/healthz',
    })
    try {
      await hb.runOnce()
      expect(calls).toBe(1)
      expect(hb.successCount()).toBe(1)
      expect(hb.failCount()).toBe(0)
      expect(logs.length).toBe(1)
      expect(logs[0]).toContain('heartbeat ok')
      expect(logs[0]).toContain('success=1')
    } finally {
      hb.stop()
    }
  })

  test('runOnce non-2xx: increments failCount, logs http status', async () => {
    const logs: string[] = []
    const fetchImpl = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response('forbidden', { status: 403 })) as typeof fetch
    const hb = startHeartbeat({
      sandboxId: 'sb-403',
      fetchImpl,
      intervalMs: 60_000,
      logger: l => logs.push(l),
      targetUrl: 'http://forbidden.local/healthz',
    })
    try {
      await hb.runOnce()
      expect(hb.successCount()).toBe(0)
      expect(hb.failCount()).toBe(1)
      expect(logs[0]).toContain('http=403')
    } finally {
      hb.stop()
    }
  })

  test('runOnce fetch throws: caught + logged as error, no exception', async () => {
    const logs: string[] = []
    const fetchImpl = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      throw new Error('boom')
    }) as typeof fetch
    const hb = startHeartbeat({
      sandboxId: 'sb-boom',
      fetchImpl,
      intervalMs: 60_000,
      logger: l => logs.push(l),
      targetUrl: 'http://boom.local/healthz',
    })
    try {
      // Must not throw — heartbeat is fail-soft
      await hb.runOnce()
      expect(hb.successCount()).toBe(0)
      expect(hb.failCount()).toBe(1)
      expect(logs[0]).toContain('error=boom')
    } finally {
      hb.stop()
    }
  })

  test('counters accumulate across multiple pings', async () => {
    let n = 0
    const fetchImpl = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => {
      n += 1
      return new Response('', { status: n % 2 === 0 ? 500 : 200 })
    }) as typeof fetch
    const hb = startHeartbeat({
      sandboxId: 'sb-mixed',
      fetchImpl,
      intervalMs: 60_000,
      targetUrl: 'http://mixed.local/healthz',
    })
    try {
      await hb.runOnce()
      await hb.runOnce()
      await hb.runOnce()
      await hb.runOnce()
      expect(hb.successCount()).toBe(2)
      expect(hb.failCount()).toBe(2)
    } finally {
      hb.stop()
    }
  })

  test('stop() is idempotent and prevents future ticks', () => {
    const fetchImpl = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response('', { status: 200 })) as typeof fetch
    const hb = startHeartbeat({ sandboxId: 'sb-stop', fetchImpl, intervalMs: 60_000 })
    hb.stop()
    hb.stop() // second call must not throw
    expect(hb.successCount()).toBe(0)
  })
})
