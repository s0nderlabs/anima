import { describe, expect, test } from 'bun:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { SandboxProviderClient } from './provider-client'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

function mockFetch(): {
  fetch: typeof fetch
  calls: RecordedCall[]
  reply: (responder: (call: RecordedCall) => Response | Promise<Response>) => void
} {
  const calls: RecordedCall[] = []
  let responder: (call: RecordedCall) => Response | Promise<Response> = () => new Response('null')
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    const initHeaders = init?.headers
    if (initHeaders) {
      const entries: Iterable<[string, string]> =
        initHeaders instanceof Headers
          ? (initHeaders as unknown as Iterable<[string, string]>)
          : Array.isArray(initHeaders)
            ? (initHeaders as Iterable<[string, string]>)
            : (Object.entries(initHeaders) as Iterable<[string, string]>)
      for (const [k, v] of entries) headers[String(k).toLowerCase()] = String(v)
    }
    let body: unknown = undefined
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const call: RecordedCall = { url, method, headers, body }
    calls.push(call)
    return responder(call)
  }) as typeof fetch
  return {
    fetch: fetchImpl,
    calls,
    reply: r => {
      responder = r
    },
  }
}

const ENDPOINT = 'https://provider.example.test'

describe('SandboxProviderClient', () => {
  test('public reads do not include auth headers', async () => {
    const m = mockFetch()
    m.reply(
      () => new Response(JSON.stringify({ create_fee: '60000000000000000' }), { status: 200 }),
    )
    const operator = privateKeyToAccount(generatePrivateKey())
    const client = new SandboxProviderClient({
      endpoint: ENDPOINT,
      operator,
      fetchImpl: m.fetch,
    })
    await client.info()
    const call = m.calls[0]
    if (!call) throw new Error('no call recorded')
    expect(call.url).toBe(`${ENDPOINT}/info`)
    expect(call.headers['x-wallet-address']).toBeUndefined()
  })

  test('createSandbox sends signed POST with payload mirrored in headers', async () => {
    const m = mockFetch()
    m.reply(() => new Response(JSON.stringify({ id: 'sbx-1', state: 'creating' }), { status: 200 }))
    const operator = privateKeyToAccount(generatePrivateKey())
    const client = new SandboxProviderClient({ endpoint: ENDPOINT, operator, fetchImpl: m.fetch })
    const r = await client.createSandbox({
      snapshot: 'daytonaio/sandbox:0.5.0-slim',
      name: 'enigma',
    })
    expect(r.id).toBe('sbx-1')
    const call = m.calls[0]
    if (!call) throw new Error('no call recorded')
    expect(call.url).toBe(`${ENDPOINT}/api/sandbox`)
    expect(call.method).toBe('POST')
    expect(call.headers['x-wallet-address']?.toLowerCase()).toBe(operator.address.toLowerCase())
    expect(call.headers['x-signed-message']).toBeTruthy()
    expect(call.headers['x-wallet-signature']).toMatch(/^0x[0-9a-f]+$/)
    expect((call.body as Record<string, unknown>).snapshot).toBe('daytonaio/sandbox:0.5.0-slim')
  })

  test('execInToolbox routes to /api/toolbox/<id>/toolbox/process/execute', async () => {
    const m = mockFetch()
    m.reply(
      () =>
        new Response(JSON.stringify({ exitCode: 0, stdout: 'hello\n', stderr: '' }), {
          status: 200,
        }),
    )
    const operator = privateKeyToAccount(generatePrivateKey())
    const client = new SandboxProviderClient({ endpoint: ENDPOINT, operator, fetchImpl: m.fetch })
    const r = await client.execInToolbox('sbx-1', { command: 'echo hello', timeout: 10 })
    expect(r.exitCode).toBe(0)
    const call = m.calls[0]
    if (!call) throw new Error('no call recorded')
    expect(call.url).toBe(`${ENDPOINT}/api/toolbox/sbx-1/toolbox/process/execute`)
    expect(call.method).toBe('POST')
    expect((call.body as Record<string, unknown>).command).toBe('echo hello')
  })

  test('deleteSandbox sends signed DELETE', async () => {
    const m = mockFetch()
    m.reply(() => new Response('', { status: 204 }))
    const operator = privateKeyToAccount(generatePrivateKey())
    const client = new SandboxProviderClient({ endpoint: ENDPOINT, operator, fetchImpl: m.fetch })
    await client.deleteSandbox('sbx-2')
    const call = m.calls[0]
    if (!call) throw new Error('no call recorded')
    expect(call.url).toBe(`${ENDPOINT}/api/sandbox/sbx-2`)
    expect(call.method).toBe('DELETE')
    expect(call.headers['x-wallet-address']).toBeTruthy()
  })

  test('non-2xx responses throw', async () => {
    const m = mockFetch()
    m.reply(() => new Response('forbidden', { status: 403 }))
    const operator = privateKeyToAccount(generatePrivateKey())
    const client = new SandboxProviderClient({ endpoint: ENDPOINT, operator, fetchImpl: m.fetch })
    await expect(client.createSandbox({ snapshot: 'x' })).rejects.toThrow(/POST.*403/)
  })

  test('archiveSandbox sends signed POST to /archive with action=archive', async () => {
    const m = mockFetch()
    m.reply(() => new Response('', { status: 204 }))
    const operator = privateKeyToAccount(generatePrivateKey())
    const client = new SandboxProviderClient({ endpoint: ENDPOINT, operator, fetchImpl: m.fetch })
    await client.archiveSandbox('sbx-archive-1')
    const call = m.calls[0]
    if (!call) throw new Error('no call recorded')
    expect(call.url).toBe(`${ENDPOINT}/api/sandbox/sbx-archive-1/archive`)
    expect(call.method).toBe('POST')
    expect(call.headers['x-wallet-address']).toBeTruthy()
    // Decode the canonical signed JSON from the base64 header to check action + resource
    const signedJson = JSON.parse(
      Buffer.from(call.headers['x-signed-message']!, 'base64').toString('utf8'),
    )
    expect(signedJson.action).toBe('archive')
    expect(signedJson.resource_id).toBe('sbx-archive-1')
  })

  test('archiveSandbox propagates non-2xx errors', async () => {
    const m = mockFetch()
    m.reply(() => new Response('not found', { status: 404 }))
    const operator = privateKeyToAccount(generatePrivateKey())
    const client = new SandboxProviderClient({
      endpoint: ENDPOINT,
      operator,
      fetchImpl: m.fetch,
      retries: 0,
    })
    await expect(client.archiveSandbox('sbx-archive-2')).rejects.toThrow(/POST.*404/)
  })

  test('read fetch attaches AbortSignal that fires on timeout (default 30s)', async () => {
    const calls: Array<{ signal: AbortSignal | undefined }> = []
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      calls.push({ signal: init?.signal ?? undefined })
      return new Response(JSON.stringify({ create_fee: '0' }), { status: 200 })
    }) as typeof fetch
    const operator = privateKeyToAccount(generatePrivateKey())
    const client = new SandboxProviderClient({
      endpoint: ENDPOINT,
      operator,
      fetchImpl,
    })
    await client.info()
    const c = calls[0]
    if (!c) throw new Error('no call')
    expect(c.signal).toBeDefined()
    expect(c.signal!.aborted).toBe(false)
  })

  test('read timeout fires when fetch hangs past read timeout', async () => {
    let abortedDuringHang = false
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      // Wait until the signal aborts (which proves the timeout wired through)
      await new Promise<void>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => {
          abortedDuringHang = true
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
      return new Response('', { status: 200 })
    }) as typeof fetch
    const operator = privateKeyToAccount(generatePrivateKey())
    const client = new SandboxProviderClient({
      endpoint: ENDPOINT,
      operator,
      fetchImpl,
      requestTimeoutMs: { read: 50 },
      retries: 0,
    })
    await expect(client.info()).rejects.toThrow()
    expect(abortedDuringHang).toBe(true)
  })

  test('write timeout uses the longer write deadline', async () => {
    const calls: Array<{ signal: AbortSignal }> = []
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      calls.push({ signal: init!.signal! })
      return new Response(JSON.stringify({ id: 'x', state: 'creating' }), { status: 200 })
    }) as typeof fetch
    const operator = privateKeyToAccount(generatePrivateKey())
    const client = new SandboxProviderClient({
      endpoint: ENDPOINT,
      operator,
      fetchImpl,
      requestTimeoutMs: { read: 1, write: 60_000 },
    })
    // Reads with 1ms timeout would already abort; writes with 60s should be fine
    await client.createSandbox({ snapshot: 'x' })
    const c = calls[0]
    if (!c) throw new Error('no call')
    expect(c.signal.aborted).toBe(false)
  })
})
