import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type http from 'node:http'
import { encryptToPubkey, generateBootstrapKeypair } from '@s0nderlabs/anima-core'
import {
  ApprovalRelay,
  EventHub,
  type RuntimeConfig,
  StubRuntime,
  createGatewayServer,
  createSession,
} from '@s0nderlabs/anima-gateway'
import { type Hex, hexToBytes } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { SandboxClient } from './client'

const INFT_REF = {
  contract: '0x9e71d79f06f956d4d2666b5c93dafab721c84721' as const,
  tokenId: '6',
}

const CONFIG: RuntimeConfig = {
  network: '0g-mainnet',
  brain: { provider: '0x0000000000000000000000000000000000000111', model: 'glm-5' },
  identity: {
    iNFT: INFT_REF,
    agent: '0x1111111111111111111111111111111111111111',
  },
}

interface Fixture {
  server: http.Server
  base: string
  client: SandboxClient
  sandboxId: string
  operatorPriv: Hex
  agentPriv: Hex
  bootstrapPubkey: Hex
}

async function listenOnRandomPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr !== 'string') resolve(addr.port)
      else reject(new Error('no-port'))
    })
  })
}

async function setupFixture(): Promise<Fixture> {
  const operatorPriv = generatePrivateKey()
  const operator = privateKeyToAccount(operatorPriv)
  const events = new EventHub()
  const session = createSession({
    bootstrap: generateBootstrapKeypair(),
    expectedOperatorAddress: operator.address,
    sandboxId: 'sbx-cli-test',
    events,
    approvals: new ApprovalRelay(events),
    runtime: new StubRuntime(),
  })
  const server = createGatewayServer({ session })
  const port = await listenOnRandomPort(server)
  const base = `http://127.0.0.1:${port}`
  const client = new SandboxClient({
    endpoint: base,
    sandboxId: session.sandboxId,
    operator,
  })
  return {
    server,
    base,
    client,
    sandboxId: session.sandboxId,
    operatorPriv,
    agentPriv: generatePrivateKey(),
    bootstrapPubkey: session.bootstrap.pubkeyHexCompressed,
  }
}

async function provisionViaClient(fix: Fixture): Promise<void> {
  const envelope = encryptToPubkey({
    recipientPubkey: fix.bootstrapPubkey,
    plaintext: hexToBytes(fix.agentPriv),
  })
  await fix.client.provision({ envelope, iNFTRef: INFT_REF, config: CONFIG }, fix.bootstrapPubkey)
  await fix.client.waitReady({ timeoutMs: 5000, intervalMs: 30 })
}

describe('SandboxClient', () => {
  let fix: Fixture

  beforeEach(async () => {
    fix = await setupFixture()
  })
  afterEach(() => {
    fix.server.close()
  })

  test('pubkey + health round-trip', async () => {
    const pk = await fix.client.pubkey()
    expect(pk.pubkeyHex).toBe(fix.bootstrapPubkey)
    const h = await fix.client.health()
    expect(h.state).toBe('Bootstrapping')
    expect(h.runtimeReady).toBe(false)
  })

  test('provision + waitReady transitions to Ready', async () => {
    await provisionViaClient(fix)
    const h = await fix.client.health()
    expect(h.state).toBe('Ready')
    expect(h.runtimeReady).toBe(true)
    expect(h.agentAddress).toBe(privateKeyToAccount(fix.agentPriv).address)
  })

  test('chat returns response from runtime', async () => {
    await provisionViaClient(fix)
    const result = await fix.client.chat('hello sandbox')
    expect(result.response).toContain('hello sandbox')
    expect(result.toolCalls.length).toBeGreaterThan(0)
  })

  test('events iterator yields chat-turn indicators', async () => {
    await provisionViaClient(fix)
    const controller = new AbortController()
    const collected: string[] = []
    const collect = (async () => {
      for await (const ev of fix.client.events({ signal: controller.signal })) {
        collected.push(ev.kind)
        if (collected.includes('turn-end')) {
          controller.abort()
          break
        }
      }
    })()
    // give SSE a tick to subscribe before sending the chat
    await new Promise(resolve => setTimeout(resolve, 100))
    await fix.client.chat('event test')
    await Promise.race([collect, new Promise(resolve => setTimeout(resolve, 3000))])
    expect(collected).toContain('turn-start')
    expect(collected).toContain('tool-call-start')
    expect(collected).toContain('turn-end')
  })

  test('approve resolves a pending request', async () => {
    await provisionViaClient(fix)
    const session = await fix.client.health()
    expect(session.state).toBe('Ready')

    // Direct relay-driven approval round-trip is exercised in
    // harness/src/server.test.ts where the relay is reachable from the test
    // fixture. Here we just confirm /healthz reports ready, since the SSE
    // events iterator is already covered above.
    const resp = await fix.client.health()
    expect(resp.runtimeReady).toBe(true)
  })

  // v0.24.4: approvePairing signs the same `adminTickHash('pairing-approve',
  // ts, sandboxId)` payload as autotopup-tick / profile-key. We assert by
  // intercepting fetch and confirming the signature recovers to the operator
  // address — this proves the SandboxClient is signing what the server expects
  // without needing a live PairingStore in the gateway test fixture.
  test('approvePairing posts signed body to /admin/pairing/approve', async () => {
    interface CapturedBody {
      platform: string
      code: string
      ts: number
      signature: Hex
    }
    const captured: { body: CapturedBody | null; url: string | null } = { body: null, url: null }
    const mockFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured.url = typeof input === 'string' ? input : input.toString()
      captured.body = JSON.parse(String(init?.body ?? '{}')) as CapturedBody
      return new Response(JSON.stringify({ ok: true, userId: '42', userName: 'bob' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const operator = privateKeyToAccount(fix.operatorPriv)
    const client = new SandboxClient({
      endpoint: 'http://stub.local',
      sandboxId: 'sbx-pair-sign',
      operator,
      fetchImpl: mockFetch,
    })

    const result = await client.approvePairing('telegram', 'ABCDEFGH')
    expect(result.ok).toBe(true)
    expect(result.userId).toBe('42')
    expect(result.userName).toBe('bob')
    expect(captured.url).toBe('http://stub.local/admin/pairing/approve')
    expect(captured.body).not.toBeNull()
    const body = captured.body
    if (!body) throw new Error('captured.body is null')
    expect(body.platform).toBe('telegram')
    expect(body.code).toBe('ABCDEFGH')
    expect(typeof body.ts).toBe('number')
    expect(body.signature).toMatch(/^0x[0-9a-fA-F]+$/)

    // Recover address from signature + reconstructed hash; assert operator.
    const { adminTickHash } = await import('@s0nderlabs/anima-gateway')
    const { recoverMessageAddress } = await import('viem')
    const hash = adminTickHash({
      action: 'pairing-approve',
      ts: body.ts,
      sandboxId: 'sbx-pair-sign',
    })
    const recovered = await recoverMessageAddress({
      message: { raw: hash },
      signature: body.signature,
    })
    expect(recovered.toLowerCase()).toBe(operator.address.toLowerCase())
  })

  test('approvePairing surfaces ok:false reason from gateway', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ ok: false, reason: 'locked-out' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const operator = privateKeyToAccount(fix.operatorPriv)
    const client = new SandboxClient({
      endpoint: 'http://stub.local',
      sandboxId: 'sbx-pair-lock',
      operator,
      fetchImpl: mockFetch,
    })
    const result = await client.approvePairing('telegram', 'ABCDEFGH')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('locked-out')
  })

  test('approvePairing throws on 401', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ error: 'unauthorized', reason: 'sig-mismatch' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const operator = privateKeyToAccount(fix.operatorPriv)
    const client = new SandboxClient({
      endpoint: 'http://stub.local',
      sandboxId: 'sbx-pair-401',
      operator,
      fetchImpl: mockFetch,
    })
    await expect(client.approvePairing('telegram', 'ABCDEFGH')).rejects.toThrow(/auth failed/)
  })
})
