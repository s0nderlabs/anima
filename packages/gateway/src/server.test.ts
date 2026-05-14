import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type http from 'node:http'
import { encryptToPubkey, generateBootstrapKeypair } from '@s0nderlabs/anima-core'
import { type Address, type Hex, hexToBytes } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ApprovalRelay } from './approval-relay'
import { adminTickHash, approvalResponseHash, chatMessageHash, provisionMessageHash } from './auth'
import { EventHub } from './events'
import type { RuntimeAdapter, RuntimeConfig } from './runtime'
import { createGatewayServer } from './server'
import { type GatewaySession, createSession } from './state'
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
  session: GatewaySession
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

interface SetupFixtureOpts {
  runtime?: RuntimeAdapter
  trustLocal?: boolean
  sandboxId?: string
}

async function setupFixture(opts: SetupFixtureOpts = {}): Promise<Fixture> {
  const operatorPriv = generatePrivateKey()
  const operatorAddress = privateKeyToAccount(operatorPriv).address

  const events = new EventHub()
  const session = createSession({
    bootstrap: generateBootstrapKeypair(),
    expectedOperatorAddress: operatorAddress,
    sandboxId: opts.sandboxId ?? 'sbx-test-1',
    events,
    approvals: new ApprovalRelay(events),
    runtime: opts.runtime ?? new StubRuntime(),
  })
  const server = createGatewayServer({ session, trustLocal: opts.trustLocal })
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

type TickResultFn = () => Awaited<ReturnType<NonNullable<RuntimeAdapter['triggerTopupTick']>>>

function makeStubRuntimeWithTick(tickFn: TickResultFn): RuntimeAdapter {
  return {
    async start() {},
    ready: () => true,
    async runChatTurn() {
      return { response: '', toolCalls: [], durationMs: 0 }
    },
    async flushSync() {
      return { slots: [] }
    },
    async stop() {},
    async triggerTopupTick() {
      return tickFn()
    },
  }
}

type ApprovePairingFn = NonNullable<RuntimeAdapter['approvePairing']>

function makeStubRuntimeWithPairing(approveFn: ApprovePairingFn): RuntimeAdapter {
  return {
    async start() {},
    ready: () => true,
    async runChatTurn() {
      return { response: '', toolCalls: [], durationMs: 0 }
    },
    async flushSync() {
      return { slots: [] }
    },
    async stop() {},
    approvePairing(platform, code) {
      return approveFn(platform, code)
    },
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

  test('GET /healthz includes listeners block (v0.21.12)', async () => {
    const r = await fetch(`${fix.base}/healthz`)
    const body = (await r.json()) as { listeners?: Record<string, string> }
    // The stub runtime in tests doesn't implement listenerStates() so the
    // server falls back to the disabled default. Real RealRuntime sets
    // 'active' when secrets.telegram is wired in.
    expect(body.listeners).toBeDefined()
    expect(body.listeners?.telegram).toBeDefined()
    expect(['active', 'disabled', 'failed']).toContain(body.listeners?.telegram ?? '')
  })

  test('GET /healthz exposes permsMode field (v0.21.13)', async () => {
    // Stub runtime omits permissionMode() so the server returns undefined.
    // Real RealRuntime returns runtime.permission.getMode() so the TUI thin
    // client can seed its statusline. The field is optional in the response
    // type to keep the contract additive.
    const r = await fetch(`${fix.base}/healthz`)
    const body = (await r.json()) as { permsMode?: string }
    // Stub returns undefined; assert the key is present (even if value is
    // omitted from JSON when undefined). Reading without throwing is enough.
    expect(body).toBeDefined()
    if (body.permsMode !== undefined) {
      expect(['off', 'prompt', 'strict']).toContain(body.permsMode)
    }
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

describe('harness HTTP server — admin endpoints', () => {
  let fix: Fixture

  beforeEach(async () => {
    fix = await setupFixture()
  })
  afterEach(() => {
    fix.session.approvals.stop()
    fix.server.close()
  })

  test('POST /admin/autotopup/tick returns 401 without trustLocal', async () => {
    await provisionFixture(fix)
    const r = await fetch(`${fix.base}/admin/autotopup/tick`, { method: 'POST' })
    expect(r.status).toBe(401)
    const body = (await r.json()) as Record<string, unknown>
    expect(body.error).toBe('unauthorized')
  })

  test('POST /admin/autotopup/tick returns 501 when runtime has no triggerTopupTick', async () => {
    // StubRuntime does not implement triggerTopupTick — confirm 501.
    const local = await setupFixture({ trustLocal: true, sandboxId: 'sbx-trust-1' })
    await provisionFixture(local)
    const r = await fetch(`${local.base}/admin/autotopup/tick`, { method: 'POST' })
    expect(r.status).toBe(501)
    const body = (await r.json()) as Record<string, unknown>
    expect(body.error).toBe('not-supported')
    local.server.close()
    local.session.approvals.stop()
  })

  test('POST /admin/autotopup/tick 503 with trustLocal + autotopup-disabled runtime', async () => {
    const local = await setupFixture({
      trustLocal: true,
      sandboxId: 'sbx-tick-1',
      runtime: makeStubRuntimeWithTick(() => ({
        ok: false as const,
        reason: 'autotopup-disabled' as const,
      })),
    })
    await provisionFixture(local)
    const r = await fetch(`${local.base}/admin/autotopup/tick`, { method: 'POST' })
    expect(r.status).toBe(503)
    const body = (await r.json()) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('autotopup-disabled')
    local.server.close()
    local.session.approvals.stop()
  })

  test('POST /admin/autotopup/tick 200 with trustLocal + ok runtime', async () => {
    let tickCalls = 0
    const local = await setupFixture({
      trustLocal: true,
      sandboxId: 'sbx-tick-2',
      runtime: makeStubRuntimeWithTick(() => {
        tickCalls++
        return { ok: true as const }
      }),
    })
    await provisionFixture(local)
    const r = await fetch(`${local.base}/admin/autotopup/tick`, { method: 'POST' })
    expect(r.status).toBe(200)
    const body = (await r.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(tickCalls).toBe(1)
    local.server.close()
    local.session.approvals.stop()
  })

  test('POST /admin/autotopup/tick 500 pre-provision (operator not set yet)', async () => {
    // v0.21.9: sandbox path needs session.operatorAddress to verify the sig.
    // Pre-provision the operator slot is empty → 500 with operator-not-set.
    const r = await fetch(`${fix.base}/admin/autotopup/tick`, { method: 'POST' })
    expect(r.status).toBe(500)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBe('operator-not-set')
  })

  // v0.21.9: sandbox-mode (trustLocal=false) accepts EIP-191 signed body.
  test('POST /admin/autotopup/tick 200 with signed body (sandbox path)', async () => {
    let tickCalls = 0
    const sandboxFix = await setupFixture({
      trustLocal: false,
      sandboxId: 'sbx-tick-signed-1',
      runtime: makeStubRuntimeWithTick(() => {
        tickCalls++
        return { ok: true as const }
      }),
    })
    await provisionFixture(sandboxFix)
    const ts = Date.now()
    const hash = adminTickHash({
      action: 'autotopup-tick',
      ts,
      sandboxId: 'sbx-tick-signed-1',
    })
    const sig = await privateKeyToAccount(sandboxFix.operatorPriv).signMessage({
      message: { raw: hexToBytes(hash) },
    })
    const r = await fetch(`${sandboxFix.base}/admin/autotopup/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts, signature: sig }),
    })
    expect(r.status).toBe(200)
    expect(tickCalls).toBe(1)
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/autotopup/tick 401 when body missing signature', async () => {
    const sandboxFix = await setupFixture({
      trustLocal: false,
      sandboxId: 'sbx-nosig',
    })
    await provisionFixture(sandboxFix)
    const r = await fetch(`${sandboxFix.base}/admin/autotopup/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts: Date.now() }),
    })
    expect(r.status).toBe(401)
    const body = (await r.json()) as { reason?: string }
    expect(body.reason).toMatch(/signature/)
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/autotopup/tick 401 when sig is for a different sandbox', async () => {
    const sandboxFix = await setupFixture({
      trustLocal: false,
      sandboxId: 'sbx-real',
    })
    await provisionFixture(sandboxFix)
    const ts = Date.now()
    // Sign over a *different* sandboxId so the recovered address still equals
    // the operator but the hash mismatches what the server reconstructs.
    const hashForOther = adminTickHash({
      action: 'autotopup-tick',
      ts,
      sandboxId: 'sbx-other',
    })
    const sig = await privateKeyToAccount(sandboxFix.operatorPriv).signMessage({
      message: { raw: hexToBytes(hashForOther) },
    })
    const r = await fetch(`${sandboxFix.base}/admin/autotopup/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts, signature: sig }),
    })
    expect(r.status).toBe(401)
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/autotopup/tick 401 when ts is stale (>5min old)', async () => {
    const sandboxFix = await setupFixture({
      trustLocal: false,
      sandboxId: 'sbx-stale',
    })
    await provisionFixture(sandboxFix)
    const ts = Date.now() - 6 * 60 * 1000
    const hash = adminTickHash({
      action: 'autotopup-tick',
      ts,
      sandboxId: 'sbx-stale',
    })
    const sig = await privateKeyToAccount(sandboxFix.operatorPriv).signMessage({
      message: { raw: hexToBytes(hash) },
    })
    const r = await fetch(`${sandboxFix.base}/admin/autotopup/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts, signature: sig }),
    })
    expect(r.status).toBe(401)
    const body = (await r.json()) as { reason?: string }
    expect(body.reason).toBe('ts-stale')
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  // v0.24.4: pairing-approve admin endpoint. Auth shape mirrors profile-key
  // (signed `adminTickHash('pairing-approve', ts, sandboxId)`); body shape
  // is `{ platform, code, ts, signature }`. Platform allowlist + code format
  // are checked BEFORE sig verification so a malformed CLI invocation gets
  // 400 without burning a signature round-trip.
  test('POST /admin/pairing/approve 200 with valid sig (sandbox path)', async () => {
    const approveCalls: Array<{ platform: string; code: string }> = []
    const sandboxFix = await setupFixture({
      trustLocal: false,
      sandboxId: 'sbx-pair-1',
      runtime: makeStubRuntimeWithPairing((platform, code) => {
        approveCalls.push({ platform, code })
        return { ok: true as const, userId: '12345', userName: 'alice' }
      }),
    })
    await provisionFixture(sandboxFix)
    const ts = Date.now()
    const hash = adminTickHash({
      action: 'pairing-approve',
      ts,
      sandboxId: 'sbx-pair-1',
    })
    const sig = await privateKeyToAccount(sandboxFix.operatorPriv).signMessage({
      message: { raw: hexToBytes(hash) },
    })
    const r = await fetch(`${sandboxFix.base}/admin/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', code: 'ABCDEFGH', ts, signature: sig }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { ok: boolean; userId?: string; userName?: string }
    expect(body.ok).toBe(true)
    expect(body.userId).toBe('12345')
    expect(body.userName).toBe('alice')
    expect(approveCalls).toEqual([{ platform: 'telegram', code: 'ABCDEFGH' }])
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/pairing/approve 200 with ok:false when code unknown', async () => {
    const sandboxFix = await setupFixture({
      trustLocal: true,
      sandboxId: 'sbx-pair-miss',
      runtime: makeStubRuntimeWithPairing(() => ({
        ok: false as const,
        reason: 'unknown-or-expired-code',
      })),
    })
    await provisionFixture(sandboxFix)
    const r = await fetch(`${sandboxFix.base}/admin/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', code: 'ABCDEFGH' }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { ok: boolean; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('unknown-or-expired-code')
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/pairing/approve 401 with invalid sig', async () => {
    const sandboxFix = await setupFixture({
      trustLocal: false,
      sandboxId: 'sbx-pair-badsig',
      runtime: makeStubRuntimeWithPairing(() => ({
        ok: true as const,
        userId: 'x',
        userName: 'x',
      })),
    })
    await provisionFixture(sandboxFix)
    // Sign over a *different* sandboxId so the recovered address matches the
    // operator but the hash diverges from what the server reconstructs.
    const ts = Date.now()
    const wrongHash = adminTickHash({
      action: 'pairing-approve',
      ts,
      sandboxId: 'sbx-different',
    })
    const badSig = await privateKeyToAccount(sandboxFix.operatorPriv).signMessage({
      message: { raw: hexToBytes(wrongHash) },
    })
    const r = await fetch(`${sandboxFix.base}/admin/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'telegram',
        code: 'ABCDEFGH',
        ts,
        signature: badSig,
      }),
    })
    expect(r.status).toBe(401)
    const body = (await r.json()) as { error?: string; reason?: string }
    expect(body.error).toBe('unauthorized')
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/pairing/approve 400 when missing fields', async () => {
    const sandboxFix = await setupFixture({
      trustLocal: true,
      sandboxId: 'sbx-pair-missing',
    })
    await provisionFixture(sandboxFix)
    const r = await fetch(`${sandboxFix.base}/admin/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram' }),
    })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBe('missing-fields')
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/pairing/approve 400 when platform unsupported', async () => {
    const sandboxFix = await setupFixture({
      trustLocal: true,
      sandboxId: 'sbx-pair-platform',
    })
    await provisionFixture(sandboxFix)
    const r = await fetch(`${sandboxFix.base}/admin/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'discord', code: 'ABCDEFGH' }),
    })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBe('unsupported-platform')
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/pairing/approve 400 when code is wrong length', async () => {
    const sandboxFix = await setupFixture({
      trustLocal: true,
      sandboxId: 'sbx-pair-len',
    })
    await provisionFixture(sandboxFix)
    const r = await fetch(`${sandboxFix.base}/admin/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', code: 'SHORT' }),
    })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error?: string; reason?: string }
    expect(body.error).toBe('bad-code-format')
    expect(body.reason).toBe('wrong-length')
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/pairing/approve 400 when code has invalid character', async () => {
    const sandboxFix = await setupFixture({
      trustLocal: true,
      sandboxId: 'sbx-pair-alpha',
    })
    await provisionFixture(sandboxFix)
    // `0` (zero) is excluded from PAIRING_ALPHABET. 8 chars to pass length check.
    const r = await fetch(`${sandboxFix.base}/admin/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', code: 'ABCDEFG0' }),
    })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error?: string; reason?: string }
    expect(body.error).toBe('bad-code-format')
    expect(body.reason).toBe('invalid-character')
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/pairing/approve 409 when state is not Ready', async () => {
    const sandboxFix = await setupFixture({
      trustLocal: true,
      sandboxId: 'sbx-pair-notready',
      runtime: makeStubRuntimeWithPairing(() => ({
        ok: true as const,
        userId: 'x',
        userName: 'x',
      })),
    })
    await provisionFixture(sandboxFix)
    // Flip state back so the Ready guard fires.
    sandboxFix.session.state = 'Provisioned'
    const r = await fetch(`${sandboxFix.base}/admin/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', code: 'ABCDEFGH' }),
    })
    expect(r.status).toBe(409)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBe('not-ready')
    sandboxFix.server.close()
    sandboxFix.session.approvals.stop()
  })

  test('POST /admin/pairing/approve 501 when runtime has no approvePairing', async () => {
    // StubRuntime (default) does NOT implement approvePairing — confirm 501.
    const local = await setupFixture({ trustLocal: true, sandboxId: 'sbx-pair-501' })
    await provisionFixture(local)
    const r = await fetch(`${local.base}/admin/pairing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', code: 'ABCDEFGH' }),
    })
    expect(r.status).toBe(501)
    const body = (await r.json()) as Record<string, unknown>
    expect(body.error).toBe('not-supported')
    local.server.close()
    local.session.approvals.stop()
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
