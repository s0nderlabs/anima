import { spinner } from '@clack/prompts'
import {
  type AnimaConfig,
  type AnimaNetwork,
  type PermissionDecision,
  type PermissionRequest,
  SANDBOX_PROVIDER_URL_GALILEO,
  SandboxProviderClient,
  iNFTAgentId,
} from '@s0nderlabs/anima-core'
import type { HarnessEventKind } from '@s0nderlabs/anima-harness'
import type { Address } from 'viem'
import { SandboxClient } from '../sandbox/client'
import { summarizeApprovalSubject } from '../ui/approval-summary'
import { shortAddr } from '../util/format'
import { loadOrPickOperatorSigner } from './init/operator-picker'
import { resumeArchivedSandbox, unlockAgentKeystore } from './init/sandbox-provision'

/**
 * Sandbox-mode chat loop. Runs when `config.deployTarget === 'sandbox'` and
 * `config.sandbox.endpoint` is set. The laptop CLI is a thin client to the
 * harness HTTP server: chat goes via POST /chat (signed), tool indicators +
 * listener events stream via /events SSE, approval modal round-trips via
 * POST /approval/:id/respond.
 *
 * The agent's privkey lives ONLY in the harness container. Operator never
 * decrypts the keystore here — that happened during `anima init` or `anima
 * deploy` when the privkey was ECIES-encrypted to the bootstrap pubkey.
 */
export async function runChatSandbox(config: AnimaConfig): Promise<void> {
  if (!config.identity.iNFT || !config.identity.agent) {
    console.log('Config has no iNFT or agent. Re-run `anima init`.')
    process.exit(1)
  }
  if (!config.sandbox?.endpoint || !config.sandbox.id) {
    console.log(
      'deployTarget is sandbox but sandbox.endpoint or sandbox.id missing. Re-run `anima init`.',
    )
    process.exit(1)
  }

  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentId = iNFTAgentId({ contractAddress, tokenId })
  const agentAddress = config.identity.agent as Address
  const sandboxEndpoint = config.sandbox.endpoint
  const sandboxId = config.sandbox.id

  const operator = await loadOrPickOperatorSigner({
    network: config.network,
    hint: config.operator,
  })
  if (!operator) {
    console.log('No operator wallet available; cannot sign chat messages.')
    process.exit(1)
  }
  const operatorAccount = await operator.account()

  const client = new SandboxClient({
    endpoint: sandboxEndpoint,
    sandboxId,
    operator: operatorAccount,
  })

  const sReady = spinner()
  sReady.start(`Connecting to harness ${sandboxEndpoint}`)
  try {
    // Fast probe first; if the harness is healthy we skip every recovery path.
    const health = await client.waitReady({ timeoutMs: 8_000, intervalMs: 1000 })
    sReady.stop(`harness ready (uptime ${(health.uptimeMs / 1000).toFixed(0)}s)`)
  } catch {
    // Harness unreachable. The sandbox might be archived/stopped/error, OR it
    // could be started but with a dead daemon (orphaned-harness). Both paths
    // converge on `resumeArchivedSandbox`, which probes state, restores if
    // needed, relaunches the harness daemon via toolbox exec, and re-handoffs
    // the agent privkey. Re-handoff requires the keystore unlock that
    // chat-sandbox normally skips.
    sReady.message('harness unreachable; attempting auto-resume')
    const provider = new SandboxProviderClient({
      endpoint: SANDBOX_PROVIDER_URL_GALILEO,
      operator: operatorAccount,
    })
    if (!config.brain.provider) {
      sReady.stop('harness unreachable AND brain provider missing; run `anima model`')
      await operator.close?.()
      process.exit(1)
    }
    let agentPrivkey: `0x${string}`
    try {
      agentPrivkey = await unlockAgentKeystore({
        operator,
        network: config.network as AnimaNetwork,
        contractAddress,
        tokenId,
        agentAddress,
      })
    } catch (e) {
      sReady.stop(`auto-resume keystore unlock failed: ${(e as Error).message.slice(0, 160)}`)
      await operator.close?.()
      process.exit(1)
    }
    try {
      await resumeArchivedSandbox({
        provider,
        sandboxId,
        sandboxEndpoint,
        operatorAccount,
        agentPrivkey,
        agentAddress,
        iNFTRef: { contract: contractAddress, tokenId },
        iNFTNetwork: config.network as AnimaNetwork,
        brain: { provider: config.brain.provider as Address, model: config.brain.model ?? '' },
        onProgress: msg => sReady.message(msg),
      })
      const health = await client.waitReady({ timeoutMs: 30_000, intervalMs: 1500 })
      sReady.stop(
        `harness back online via auto-resume (uptime ${(health.uptimeMs / 1000).toFixed(0)}s)`,
      )
    } catch (e) {
      sReady.stop(`auto-resume failed: ${(e as Error).message.slice(0, 200)}`)
      await operator.close?.()
      process.exit(1)
    }
  }

  // opentui import dance: render() runs the chat UI; clack spinners must
  // finish before we hand stdin off to opentui (see comment in chat.tsx).
  const { render } = await import('@opentui/solid')
  const { createCliRenderer } = await import('@opentui/core')
  const { createChatState } = await import('../ui/state')
  const { ChatApp } = await import('../ui/app')

  const state = createChatState({
    initialSystem: `connected to sandbox ${sandboxId.slice(0, 8)} @ ${sandboxEndpoint}`,
    identityLabel: `agent ${agentId}  ${shortAddr(agentAddress)}`,
    brainLabel: shortAddr(config.brain.provider),
    approvalsMode: 'off',
  })

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    consoleMode: 'disabled',
    openConsoleOnError: false,
  })

  // Pending approval id → forward to harness via signed POST. The TUI's
  // existing y/s/n handler calls `pending.resolve(decision)`; our resolver
  // fires off the signed POST. Local promise resolves immediately (the
  // harness's ApprovalRelay handles the actual permission unblock).
  const approvalIdRef: { current: string | null } = { current: null }

  const renderEvent = (kind: HarnessEventKind, data: unknown): void => {
    const d = data as Record<string, unknown>
    switch (kind) {
      case 'tool-call-start':
        state.pushRow({
          role: 'tool-call',
          text: '',
          toolName: String(d.name ?? '?'),
          args: String(d.args ?? ''),
        })
        break
      case 'tool-call-end':
        state.pushRow({
          role: 'tool-result',
          text: String(d.summary ?? (d.ok ? 'ok' : 'failed')),
          failed: d.ok === false,
        })
        break
      case 'sync-flush': {
        const tx = String(d.txHash ?? '')
        const slots = Array.isArray(d.slots) ? (d.slots as string[]).join(', ') : ''
        const explorer = String(d.explorer ?? '')
        state.pushRow({
          role: 'system',
          text: explorer ? `synced ${slots} → ${explorer}` : `synced ${slots} (tx ${tx})`,
        })
        break
      }
      case 'listener-event': {
        const k = String(d.kind ?? '')
        if (k === 'a2a-delivered') {
          state.pushRow({
            role: 'inbox',
            text: `from ${d.fromLabel ?? d.from} · ${d.preview ?? ''}`,
          })
        } else if (k === 'market-job') {
          state.pushRow({
            role: 'market',
            text: `job#${d.jobId ?? '?'} · ${d.jobKind ?? '?'} · tx ${String(d.txHash ?? '').slice(0, 10)}`,
          })
        } else if (k === 'a2a-notice') {
          state.pushRow({
            role: 'system',
            text: `inbox notice: ${d.noticeKind ?? '?'} from ${d.from ?? ''}`,
          })
        }
        break
      }
      case 'approval-needed': {
        const req = (d.payload ?? {}) as PermissionRequest
        const id = String(d.id ?? '')
        approvalIdRef.current = id
        state.pushRow({
          role: 'system',
          text: `[approval requested] ${req.reason}: ${summarizeApprovalSubject(req)}`,
        })
        state.setPendingApproval({
          request: req,
          resolve: (decision: PermissionDecision) => {
            // Fire-and-forget: harness ApprovalRelay handles the resolve.
            void client.approve(id, decision).catch(err => {
              state.pushRow({
                role: 'system',
                text: `approval send failed: ${(err as Error).message.slice(0, 200)}`,
              })
            })
            approvalIdRef.current = null
          },
        })
        break
      }
      case 'approval-expired':
        if (approvalIdRef.current === d.id) {
          state.setPendingApproval(null)
          approvalIdRef.current = null
        }
        state.pushRow({ role: 'system', text: `approval ${d.id ?? '?'} expired` })
        break
      case 'state-change':
        if (d.state === 'ShuttingDown') {
          state.pushRow({ role: 'system', text: 'harness state: ShuttingDown' })
        }
        break
      case 'log':
        // Suppressed unless verbose flag set; for v0.15.0 keep silent.
        break
      default:
        break
    }
  }

  const eventSignal = new AbortController()
  const eventLoop = (async () => {
    try {
      for await (const ev of client.events({ signal: eventSignal.signal })) {
        renderEvent(ev.kind, ev.data)
      }
    } catch (err) {
      if (eventSignal.signal.aborted) return
      state.pushRow({
        role: 'system',
        text: `event stream lost: ${(err as Error).message}`,
      })
    }
  })()

  const handleSubmit = async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed.startsWith('/')) {
      const handled = await handleSlash(trimmed)
      if (handled) {
        state.setStatus('idle')
        return
      }
    }
    state.setStatus('thinking')
    state.setTurnStartedAt(Date.now())
    try {
      const r = await client.chat(text)
      state.pushRow({ role: 'assistant', text: r.response })
      state.setStatus('idle')
      if (r.syncTx) {
        state.pushRow({ role: 'system', text: `auto-sync → tx ${r.syncTx}` })
      }
    } catch (err) {
      state.pushRow({
        role: 'system',
        text: `chat failed: ${(err as Error).message.slice(0, 300)}`,
      })
      state.setStatus('error')
    } finally {
      state.setActiveAbort(null)
    }
  }

  const handleSlash = async (cmd: string): Promise<boolean> => {
    if (cmd === '/exit' || cmd === '/quit') {
      state.pushRow({ role: 'system', text: 'goodbye.' })
      handleExit()
      return true
    }
    if (cmd === '/sync') {
      state.pushRow({ role: 'system', text: 'flushing memory + activity to 0G…' })
      try {
        const r = await client.sync()
        if (r.tx) {
          state.pushRow({
            role: 'system',
            text: `synced ${r.slots.join(', ')} → tx ${r.tx}`,
          })
        } else {
          state.pushRow({ role: 'system', text: 'nothing to sync' })
        }
      } catch (e) {
        state.pushRow({
          role: 'system',
          text: `sync error: ${(e as Error).message.slice(0, 200)}`,
        })
      }
      return true
    }
    if (cmd === '/help') {
      state.pushRow({
        role: 'system',
        text: 'sandbox-mode slash commands:\n  /sync   force memory + activity flush via remote harness\n  /exit   quit (harness keeps running)\n  /help   this message',
      })
      return true
    }
    return false
  }

  const handleExit = (): void => {
    eventSignal.abort()
    void eventLoop.then(() => {})
    try {
      renderer.destroy()
    } catch {}
    void operator.close?.()
    process.exit(0)
  }

  await render(
    () => <ChatApp state={state} onSubmit={handleSubmit} onExit={handleExit} />,
    renderer,
  )

  await new Promise<void>(() => {
    // Block forever; only handleExit (via process.exit) escapes.
  })
}
