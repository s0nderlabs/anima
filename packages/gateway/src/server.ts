import http from 'node:http'
import { decryptWithPrivkey } from '@s0nderlabs/anima-core'
import { type Address, type Hex, bytesToHex, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type ProvisionRequest,
  verifyAdminTickSig,
  verifyApprovalSig,
  verifyChatSig,
  verifyProvisionSig,
} from './auth'
import type { EventHub, GatewayEvent } from './events'
import type { RuntimeConfig } from './runtime'
import { type GatewaySession, transitionToProvisioned, transitionToReady } from './state'

export interface ServerDeps {
  session: GatewaySession
  logger?: (line: string) => void
  /**
   * When true, skip EIP-191 sig checks on /chat and /approval routes. Used
   * by the local-mode gateway where the unix socket file permission (0600)
   * provides equivalent authentication: only the user who owns the socket
   * can connect, so wallet-sig replay defense is unnecessary. /provision
   * is unreachable in local mode anyway (session starts in Ready state).
   */
  trustLocal?: boolean
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

async function readJson(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function ssePayload(event: GatewayEvent): string {
  return `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify({ ts: event.ts, data: event.data })}\n\n`
}

function attachSse(res: http.ServerResponse, hub: EventHub, sinceSeq?: number): () => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  res.write(': hello\n\n')

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n')
  }, 15_000)
  heartbeat.unref?.()

  const unsub = hub.subscribe(event => {
    if (!res.writableEnded) res.write(ssePayload(event))
  }, sinceSeq)

  const cleanup = (): void => {
    clearInterval(heartbeat)
    unsub()
    if (!res.writableEnded) res.end()
  }
  res.on('close', cleanup)
  return cleanup
}

export function createGatewayServer(deps: ServerDeps): http.Server {
  const log = deps.logger ?? (() => {})
  const { session } = deps
  const trustLocal = deps.trustLocal === true

  return http.createServer(async (req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && url === '/bootstrap/pubkey') {
        return send(res, 200, {
          pubkeyHex: session.bootstrap.pubkeyHexCompressed,
          version: session.version,
          sandboxId: session.sandboxId,
          state: session.state,
          bootedAt: session.bootedAt,
        })
      }

      if (method === 'GET' && url === '/healthz') {
        return send(res, 200, {
          state: session.state,
          sandboxId: session.sandboxId,
          version: session.version,
          uptimeMs: Date.now() - session.bootedAt,
          bootedAt: session.bootedAt,
          provisionedAt: session.provisionedAt,
          readyAt: session.readyAt,
          agentAddress: session.agentAddress,
          runtimeReady: session.runtime.ready(),
          eventsLastSeq: session.events.lastSeq(),
          subscribers: session.events.size(),
          pendingApprovals: session.approvals.pendingCount(),
        })
      }

      if (method === 'GET' && (url === '/events' || url.startsWith('/events?'))) {
        const sinceHeader = req.headers['last-event-id']
        const sinceSeq = sinceHeader ? Number.parseInt(String(sinceHeader), 10) : undefined
        attachSse(res, session.events, Number.isFinite(sinceSeq) ? sinceSeq : undefined)
        return
      }

      if (method === 'POST' && url === '/bootstrap/provision') {
        if (session.state !== 'Bootstrapping') {
          return send(res, 409, { error: 'already-provisioned', state: session.state })
        }

        const body = (await readJson(req)) as {
          envelope: ProvisionRequest['envelope']
          secretsEnvelope?: ProvisionRequest['envelope']
          operatorAddress: Address
          iNFTRef: ProvisionRequest['iNFTRef']
          config: RuntimeConfig
          ts: number
          signature: Hex
        }

        if (
          !body?.envelope ||
          !body.operatorAddress ||
          !body.iNFTRef ||
          !body.config ||
          !body.signature
        ) {
          return send(res, 400, { error: 'missing-fields' })
        }

        const request: ProvisionRequest = {
          envelope: body.envelope,
          secretsEnvelope: body.secretsEnvelope,
          operatorAddress: getAddress(body.operatorAddress),
          iNFTRef: { contract: getAddress(body.iNFTRef.contract), tokenId: body.iNFTRef.tokenId },
          config: body.config,
          ts: body.ts,
        }

        const verified = await verifyProvisionSig({
          request,
          signature: body.signature,
          bootstrapPubkey: session.bootstrap.pubkeyHexCompressed,
          expectedOperator: session.expectedOperatorAddress,
        })
        if (!verified.ok) {
          log(`provision-rejected reason=${verified.reason}`)
          return send(res, 401, { error: 'unauthorized', reason: verified.reason })
        }

        let agentPrivkeyBytes: Uint8Array
        try {
          agentPrivkeyBytes = decryptWithPrivkey({
            recipientPrivkey: session.bootstrap.privkeyHex,
            envelope: request.envelope,
          })
        } catch (e) {
          log(`provision-decrypt-fail: ${(e as Error).message}`)
          return send(res, 400, { error: 'decrypt-failed' })
        }
        if (agentPrivkeyBytes.length !== 32) {
          return send(res, 400, { error: 'plaintext-length', length: agentPrivkeyBytes.length })
        }

        const agentPrivkey = bytesToHex(agentPrivkeyBytes) as Hex
        const agentAddress = privateKeyToAccount(agentPrivkey).address

        // Optional secrets envelope (Phase 12 / B6). Decrypted with the
        // bootstrap privkey same as the agent privkey envelope. JSON parsed
        // against the GatewaySecrets zod schema; failures abort provision.
        let secrets: import('./secrets').GatewaySecrets | undefined
        if (request.secretsEnvelope) {
          let secretsBytes: Uint8Array
          try {
            secretsBytes = decryptWithPrivkey({
              recipientPrivkey: session.bootstrap.privkeyHex,
              envelope: request.secretsEnvelope,
            })
          } catch (e) {
            log(`secrets-decrypt-fail: ${(e as Error).message}`)
            return send(res, 400, { error: 'secrets-decrypt-failed' })
          }
          try {
            const { parseGatewaySecrets } = await import('./secrets')
            secrets = parseGatewaySecrets(new TextDecoder().decode(secretsBytes))
          } catch (e) {
            log(`secrets-parse-fail: ${(e as Error).message}`)
            return send(res, 400, { error: 'secrets-parse-failed' })
          }
        }

        transitionToProvisioned(session, {
          agentPrivkey,
          agentAddress,
          operatorAddress: request.operatorAddress,
          iNFTRef: request.iNFTRef,
          config: request.config,
        })
        log(
          `provisioned agent=${agentAddress} state=${session.state}${secrets?.telegram ? ' (with telegram secrets)' : ''}`,
        )

        send(res, 200, {
          ok: true,
          agentAddress,
          state: session.state,
          provisionedAt: session.provisionedAt,
        })

        // v0.21.10: enrich the provision config with operator + deployTarget
        // before runtime.start so account.balance can read the sandbox billing
        // reserve (needs both fields). The provision envelope already carries
        // operatorAddress at the top level for sig verification; we mirror it
        // into config.identity.operator for the runtime ctx, and force
        // deployTarget='sandbox' since the harness only ever runs in a sandbox.
        const enrichedConfig: RuntimeConfig = {
          ...request.config,
          identity: {
            ...request.config.identity,
            operator: request.operatorAddress,
          },
          deployTarget: 'sandbox',
        }
        Promise.resolve()
          .then(async () => {
            await session.runtime.start({
              agentPrivkey,
              config: enrichedConfig,
              events: session.events,
              secrets,
            })
            transitionToReady(session)
            log(`runtime ready agent=${agentAddress}`)
          })
          .catch(err => {
            log(`runtime-start-error: ${(err as Error).message}`)
          })
        return
      }

      if (method === 'POST' && url === '/chat') {
        if (session.state !== 'Ready') {
          return send(res, 409, { error: 'not-ready', state: session.state })
        }
        const body = (await readJson(req)) as {
          message: string
          ts: number
          signature?: Hex
          operatorAddress?: Address
        }
        if (!body?.message || typeof body.ts !== 'number') {
          return send(res, 400, { error: 'missing-fields' })
        }
        const operator = session.operatorAddress
        if (!operator) {
          return send(res, 500, { error: 'operator-not-set' })
        }
        if (!trustLocal) {
          if (!body.signature) {
            return send(res, 400, { error: 'missing-fields' })
          }
          const verified = await verifyChatSig({
            message: body.message,
            ts: body.ts,
            sandboxId: session.sandboxId,
            signature: body.signature,
            expectedOperator: operator,
          })
          if (!verified.ok) {
            log(`chat-rejected reason=${verified.reason}`)
            return send(res, 401, { error: 'unauthorized', reason: verified.reason })
          }
        }
        try {
          const result = await session.runtime.runChatTurn({
            message: body.message,
            ts: body.ts,
            signature: body.signature ?? '0x',
            operatorAddress: operator,
          })
          return send(res, 200, result)
        } catch (e) {
          log(`chat-error: ${(e as Error).message}`)
          return send(res, 500, { error: 'turn-failed', detail: (e as Error).message })
        }
      }

      if (method === 'POST' && url === '/sync') {
        if (session.state !== 'Ready') {
          return send(res, 409, { error: 'not-ready', state: session.state })
        }
        try {
          const result = await session.runtime.flushSync()
          return send(res, 200, result)
        } catch (e) {
          return send(res, 500, { error: 'sync-failed', detail: (e as Error).message })
        }
      }

      // v0.21.5 → v0.21.9: admin endpoint to live-fire an AutoTopupManager tick.
      // Two auth paths:
      //   1. Local sock (trustLocal=true via 0600 unix-sock perm): direct allow.
      //   2. Sandbox endpoint (trustLocal=false): requires { ts, signature } body
      //      EIP-191-signed by the operator over `adminTickHash('autotopup-tick',
      //      ts, sandboxId)`. Replay-protected by ts window (±5min) and bound to
      //      the sandboxId so a sig for one container can't fire on another.
      if (method === 'POST' && url === '/admin/autotopup/tick') {
        if (!trustLocal) {
          const operator = session.operatorAddress
          if (!operator) {
            return send(res, 500, { error: 'operator-not-set' })
          }
          const body = (await readJson(req).catch(() => null)) as {
            ts?: number
            signature?: Hex
          } | null
          if (!body || typeof body.ts !== 'number' || !body.signature) {
            return send(res, 401, {
              error: 'unauthorized',
              reason: 'sandbox admin requires {ts, signature} body signed by operator',
            })
          }
          const verify = await verifyAdminTickSig({
            action: 'autotopup-tick',
            ts: body.ts,
            sandboxId: session.sandboxId,
            signature: body.signature,
            expectedOperator: operator,
          })
          if (!verify.ok) {
            return send(res, 401, { error: 'unauthorized', reason: verify.reason })
          }
        }
        if (session.state !== 'Ready') {
          return send(res, 409, { error: 'not-ready', state: session.state })
        }
        if (!session.runtime.triggerTopupTick) {
          return send(res, 501, { error: 'not-supported' })
        }
        try {
          const result = await session.runtime.triggerTopupTick()
          return send(res, result.ok ? 200 : 503, result)
        } catch (e) {
          return send(res, 500, { error: 'tick-failed', detail: (e as Error).message })
        }
      }

      const approvalMatch = url.match(/^\/approval\/([^/]+)\/respond$/)
      if (method === 'POST' && approvalMatch?.[1]) {
        const approvalId = approvalMatch[1]
        const body = (await readJson(req)) as {
          decision: 'allow' | 'allow-session' | 'deny'
          ts: number
          signature?: Hex
        }
        if (!body?.decision || typeof body.ts !== 'number') {
          return send(res, 400, { error: 'missing-fields' })
        }
        const operator = session.operatorAddress
        if (!operator) {
          return send(res, 500, { error: 'operator-not-set' })
        }
        if (!session.approvals.has(approvalId)) {
          return send(res, 404, { error: 'unknown-approval', id: approvalId })
        }
        if (!trustLocal) {
          if (!body.signature) {
            return send(res, 400, { error: 'missing-fields' })
          }
          const verified = await verifyApprovalSig({
            approvalId,
            decision: body.decision,
            ts: body.ts,
            sandboxId: session.sandboxId,
            signature: body.signature,
            expectedOperator: operator,
          })
          if (!verified.ok) {
            log(`approval-rejected id=${approvalId} reason=${verified.reason}`)
            return send(res, 401, { error: 'unauthorized', reason: verified.reason })
          }
        }
        const ok = session.approvals.resolve(approvalId, body.decision)
        return send(res, ok ? 200 : 409, { ok, id: approvalId, decision: body.decision })
      }

      send(res, 404, { error: 'not-found', method, url })
    } catch (e) {
      log(`server-error: ${(e as Error).message}`)
      if (!res.headersSent) send(res, 500, { error: 'internal' })
    }
  })
}
