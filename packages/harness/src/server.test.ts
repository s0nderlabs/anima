import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type http from 'node:http'
import { encryptToPubkey, generateBootstrapKeypair } from '@s0nderlabs/anima-core'
import { type Address, type Hex, hexToBytes } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ApprovalRelay } from './approval-relay'
import { approvalResponseHash, chatMessageHash, provisionMessageHash } from './auth'
import { EventHub } from './events'
import type { RuntimeConfig } from './runtime'
import { createHarnessServer } from './server'
import { type HarnessSession, createSession } from './state'
import { StubRuntime } from './stub-runtime'

const INFT_REF = { contract: '0x9e71d79f06f956d4d2666b5c93dafab721c84721', tokenId: '6' } as const

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
  port: number
  base: string
  session: HarnessSession
  operatorPriv: Hex
  operatorAddress: Address
  agentPriv: Hex
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
  const operatorAddress = privateKeyToAccount(operatorPriv).address

  const events = new EventHub()
  const session = createSession({
    bootstrap: generateBootstrapKeypair(),
    expectedOperatorAddress: operatorAddress,
    sandboxId: 'sbx-test-1',
    events,
    approvals: new ApprovalRelay(events),
    runtime: new StubRuntime(),
  })
  const server = createHarnessServer({ session })
  const port = await listenOnRandomPort(server)
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    session,
    operatorPriv,
    operatorAddress,
    agentPriv: generatePrivateKey(),
  }
}

async function provisionFixture(fix: Fixture): Promise<void> {
  const envelope = encryptToPubkey({
    recipientPubkey: fix.session.bootstrap.pubkeyHexCompressed,
    plaintext: hexToBytes(fix.agentPriv),
  })
  const ts = Date.now()
  const request = {
    envelope,
    operatorAddress: fix.operatorAddress,
    iNFTRef: INFT_REF,
    config: CONFIG,
    ts,
  }
  const hash = provisionMessageHash(request, fix.session.bootstrap.pubkeyHexCompressed)
  const signature = await privateKeyToAccount(fix.operatorPriv).signMessage({
    message: { raw: hash },
  })
  const r = await fetch(`${fix.base}/bootstrap/provision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, signature }),
  })
  if (r.status !== 200) throw new Error(`provision failed: ${r.status}`)

  // Wait for runtime to start (Provisioned → Ready)
  for (let i = 0; i < 50; i++) {
    if (fix.session.state === 'Ready') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`runtime never became Ready, state=${fix.session.state}`)
}

describe('harness HTTP server — provision + lifecycle', () => {
  let fix: Fixture

  beforeEach(async () => {
    fix = await setupFixture()
  })
  afterEach(() => {
    fix.session.approvals.stop()
    fix.server.close()
  })

  test('GET /bootstrap/pubkey returns harness identity', async () => {
    const r = await fetch(`${fix.base}/bootstrap/pubkey`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as Record<string, unknown>
    expect(body.pubkeyHex).toBe(fix.session.bootstrap.pubkeyHexCompressed)
    expect(body.sandboxId).toBe('sbx-test-1')
    expect(body.state).toBe('Bootstrapping')
  })

  test('GET /healthz reflects state', async () => {
    const r = await fetch(`${fix.base}/healthz`)
    const body = (await r.json()) as Record<string, unknown>
    expect(body.state).toBe('Bootstrapping')
    expect(body.runtimeReady).toBe(false)
  })

  test('POST /bootstrap/provision happy path → Provisioned then Ready', async () => {
    await provisionFixture(fix)
    expect(fix.session.state).toBe('Ready')
    expect(fix.session.runtime.ready()).toBe(true)
    expect(fix.session.config?.network).toBe('0g-mainnet')

    const r = await fetch(`${fix.base}/healthz`)
    const body = (await r.json()) as Record<string, unknown>
    expect(body.state).toBe('Ready')
    expect(body.runtimeReady).toBe(true)
  })

  test('POST /bootstrap/provision rejects bad signature', async () => {
    const envelope = encryptToPubkey({
      recipientPubkey: fix.session.bootstrap.pubkeyHexCompressed,
      plaintext: hexToBytes(fix.agentPriv),
    })
    const r = await fetch(`${fix.base}/bootstrap/provision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        envelope,
        operatorAddress: fix.operatorAddress,
        iNFTRef: INFT_REF,
        config: CONFIG,
        ts: Date.now(),
        signature: `0x${'aa'.repeat(65)}`,
      }),
    })
    expect(r.status).toBe(401)
    expect(fix.session.state).toBe('Bootstrapping')
  })

  test('POST /bootstrap/provision rejects second provision', async () => {
    await provisionFixture(fix)
    const envelope = encryptToPubkey({
      recipientPubkey: fix.session.bootstrap.pubkeyHexCompressed,
      plaintext: hexToBytes(fix.agentPriv),
    })
    const ts = Date.now()
    const request = {
      envelope,
      operatorAddress: fix.operatorAddress,
      iNFTRef: INFT_REF,
      config: CONFIG,
      ts,
    }
    const hash = provisionMessageHash(request, fix.session.bootstrap.pubkeyHexCompressed)
    const signature = await privateKeyToAccount(fix.operatorPriv).signMessage({
      message: { raw: hash },
    })
    const r2 = await fetch(`${fix.base}/bootstrap/provision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, signature }),
    })
    expect(r2.status).toBe(409)
  })

  test('unknown route returns 404', async () => {
    const r = await fetch(`${fix.base}/unknown`)
    expect(r.status).toBe(404)
  })
})

describe('harness HTTP server — chat + sync', () => {
  let fix: Fixture

  beforeEach(async () => {
    fix = await setupFixture()
    await provisionFixture(fix)
  })
  afterEach(() => {
    fix.session.approvals.stop()
    fix.server.close()
  })

  test('POST /chat with operator-signed message → echoes', async () => {
    const ts = Date.now()
    const message = 'hello enigma'
    const sig = await privateKeyToAccount(fix.operatorPriv).signMessage({
      message: { raw: chatMessageHash(message, ts, fix.session.sandboxId) },
    })
    const r = await fetch(`${fix.base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, ts, signature: sig }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { response: string; toolCalls: unknown[] }
    expect(body.response).toContain('hello enigma')
    expect(body.toolCalls.length).toBeGreaterThan(0)
  })

  test('POST /chat rejects unsigned', async () => {
    const r = await fetch(`${fix.base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'hi',
        ts: Date.now(),
        signature: `0x${'aa'.repeat(65)}`,
      }),
    })
    expect(r.status).toBe(401)
  })

  test('POST /chat returns 409 if not Ready', async () => {
    fix.session.state = 'Provisioned'
    const ts = Date.now()
    const sig = await privateKeyToAccount(fix.operatorPriv).signMessage({
      message: { raw: chatMessageHash('hi', ts, fix.session.sandboxId) },
    })
    const r = await fetch(`${fix.base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', ts, signature: sig }),
    })
    expect(r.status).toBe(409)
  })

  test('POST /sync triggers runtime flush', async () => {
    const r = await fetch(`${fix.base}/sync`, { method: 'POST' })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { slots: unknown[] }
    expect(Array.isArray(body.slots)).toBe(true)
  })
})

describe('harness HTTP server — events SSE', () => {
  let fix: Fixture

  beforeEach(async () => {
    fix = await setupFixture()
    await provisionFixture(fix)
  })
  afterEach(() => {
    fix.session.approvals.stop()
    fix.server.close()
  })

  test('GET /events streams events; chat turn produces tool indicators', async () => {
    const controller = new AbortController()
    const eventsRes = await fetch(`${fix.base}/events`, { signal: controller.signal })
    expect(eventsRes.status).toBe(200)
    const reader = eventsRes.body?.getReader()
    if (!reader) throw new Error('no reader')

    const collected: string[] = []
    const collect = (async () => {
      const decoder = new TextDecoder()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        collected.push(decoder.decode(value))
        if (collected.join('').includes('turn-end')) break
      }
    })()

    const ts = Date.now()
    const sig = await privateKeyToAccount(fix.operatorPriv).signMessage({
      message: { raw: chatMessageHash('test event', ts, fix.session.sandboxId) },
    })
    await fetch(`${fix.base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'test event', ts, signature: sig }),
    })

    await Promise.race([collect, new Promise(resolve => setTimeout(resolve, 2000))])
    controller.abort()

    const stream = collected.join('')
    expect(stream).toContain('turn-start')
    expect(stream).toContain('tool-call-start')
    expect(stream).toContain('tool-call-end')
    expect(stream).toContain('turn-end')
  })
})

describe('harness HTTP server — approval bridge', () => {
  let fix: Fixture

  beforeEach(async () => {
    fix = await setupFixture()
    await provisionFixture(fix)
  })
  afterEach(() => {
    fix.session.approvals.stop()
    fix.server.close()
  })

  test('approval round-trip: harness requests → operator responds → resolves', async () => {
    const { id, promise } = fix.session.approvals.request({
      kind: 'chain.send',
      amount: '0.001',
      recipient: '0xCCCCCCCCcccccccccccCCCCCcCCcccccccccccCCC',
    })

    const ts = Date.now()
    const hash = approvalResponseHash({
      approvalId: id,
      decision: 'allow',
      ts,
      sandboxId: fix.session.sandboxId,
    })
    const sig = await privateKeyToAccount(fix.operatorPriv).signMessage({ message: { raw: hash } })

    const r = await fetch(`${fix.base}/approval/${id}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', ts, signature: sig }),
    })
    expect(r.status).toBe(200)

    const decision = await promise
    expect(decision).toBe('allow')
  })

  test('approval rejects bad signature', async () => {
    const { id } = fix.session.approvals.request({ kind: 'chain.send' })
    const r = await fetch(`${fix.base}/approval/${id}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'allow',
        ts: Date.now(),
        signature: `0x${'aa'.repeat(65)}`,
      }),
    })
    expect(r.status).toBe(401)
  })

  test('unknown approval id returns 404', async () => {
    const ts = Date.now()
    const sig = await privateKeyToAccount(fix.operatorPriv).signMessage({
      message: {
        raw: approvalResponseHash({
          approvalId: 'nonexistent',
          decision: 'allow',
          ts,
          sandboxId: fix.session.sandboxId,
        }),
      },
    })
    const r = await fetch(`${fix.base}/approval/nonexistent/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', ts, signature: sig }),
    })
    expect(r.status).toBe(404)
  })
})
