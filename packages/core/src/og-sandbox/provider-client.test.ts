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
})
