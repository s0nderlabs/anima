import { spinner } from '@clack/prompts'
import {
  type AnimaConfig,
  type AnimaNetwork,
  NETWORK_RPC,
  type PermissionDecision,
  type PermissionRequest,
  SANDBOX_PROVIDER_URL_GALILEO,
  SandboxProviderClient,
  agentPaths,
  getLedgerDetailReadOnly,
  getSandboxBillingReserve,
  iNFTAgentId,
} from '@s0nderlabs/anima-core'
import type { GatewayEventKind } from '@s0nderlabs/anima-gateway'
import { http, type Address, createPublicClient, formatEther } from 'viem'
import { SandboxClient } from '../sandbox/client'
import { summarizeApprovalSubject } from '../ui/approval-summary'
import { loadTelegramHandoffSecrets } from '../util/telegram-secrets'
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
export interface RunChatSandboxOpts {
  /**
   * When set, the client routes via this unix socket instead of the configured
   * sandbox.endpoint TCP URL. Used for the local-gateway-daemon path
   * (Phase 14): chat.tsx detects `~/.anima/agents/<id>/gateway.sock` and calls
   * runChatSandbox with this opt; the sandbox-specific recovery path
   * (resumeArchivedSandbox) is skipped because there's no Daytona to resume.
   */
  unixSocketPath?: string
}

export async function runChatSandbox(
  config: AnimaConfig,
  opts: RunChatSandboxOpts = {},
): Promise<void> {
  if (!config.identity.iNFT || !config.identity.agent) {
    console.log('Config has no iNFT or agent. Re-run `anima init`.')
    process.exit(1)
  }
  const isLocalGateway = !!opts.unixSocketPath
  if (!isLocalGateway && (!config.sandbox?.endpoint || !config.sandbox.id)) {
    console.log(
      'deployTarget is sandbox but sandbox.endpoint or sandbox.id missing. Re-run `anima init`.',
    )
    process.exit(1)
  }

  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentId = iNFTAgentId({ contractAddress, tokenId })
  const agentAddress = config.identity.agent as Address
  const sandboxEndpoint = isLocalGateway ? 'http://localhost' : (config.sandbox?.endpoint as string)
  const sandboxId = isLocalGateway ? `local-${agentId.slice(0, 8)}` : (config.sandbox?.id as string)

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
    unixSocketPath: opts.unixSocketPath,
  })

  const sReady = spinner()
  const probeLabel = isLocalGateway ? 'local gateway socket' : `harness ${sandboxEndpoint}`
  sReady.start(`Connecting to ${probeLabel}`)
  // v0.21.13: capture initial perms mode from /healthz so the TUI statusline
  // reflects the gateway's actual PermissionService state (not hardcoded 'off').
  let initialPermsMode: 'off' | 'prompt' | 'strict' = 'off'
  try {
    // Fast probe first; if the harness is healthy we skip every recovery path.
    const health = await client.waitReady({ timeoutMs: 8_000, intervalMs: 1000 })
    if (health.permsMode) initialPermsMode = health.permsMode
    sReady.stop(
      `${isLocalGateway ? 'gateway' : 'harness'} ready (uptime ${(health.uptimeMs / 1000).toFixed(0)}s)`,
    )
  } catch {
    // Local gateway has no Daytona to resume — the daemon is either alive or
    // it isn't. Tell the user to (re)start it and exit.
    if (isLocalGateway) {
      sReady.stop(
        `gateway unreachable at ${opts.unixSocketPath} — try \`anima gateway start\` then re-run`,
      )
      await operator.close?.()
      process.exit(1)
    }
    // Sandbox path: harness might be archived/stopped/error, OR it could be
    // started but with a dead daemon (orphaned-harness). Both paths converge
    // on `resumeArchivedSandbox`, which probes state, restores if needed,
    // relaunches the harness daemon via toolbox exec, and re-handoffs the
    // agent privkey. Re-handoff requires the keystore unlock that
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
    const telegramSecretsPlain = await loadTelegramHandoffSecrets({
      signer: operator,
      agentAddress,
      contractAddress,
      tokenId,
      onNotice: msg => sReady.message(msg),
    })
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
        telegramSecrets: telegramSecretsPlain,
        onProgress: msg => sReady.message(msg),
      })
      const health = await client.waitReady({ timeoutMs: 30_000, intervalMs: 1500 })
      if (health.permsMode) initialPermsMode = health.permsMode
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
    // v0.24.4: branch on isLocalGateway. Local-gateway TUI talks to a daemon
    // over a unix socket (`~/.anima/agents/<id>/gateway.sock`) — calling that
    // "sandbox" mislead operators into believing they were paying sandbox
    // billing fees and into expecting a Daytona-style endpoint. The
    // standalone gateway path gets a clearer label; sandbox path keeps its
    // existing "connected to sandbox X @ Y" copy.
    initialSystem: isLocalGateway
      ? `connected to local gateway (${agentPaths.agent(agentId).dir}/gateway.sock)`
      : `connected to sandbox ${sandboxId.slice(0, 8)} @ ${sandboxEndpoint}`,
    // v0.22.0: subname (if registered) + full EOA. Brain provider dropped.
    identityLabel: `agent ${config.subname ?? agentId}  ${agentAddress}`,
    // v0.21.13: seeded from /healthz.permsMode so the statusline reflects
    // the gateway's actual mode after auto-spawn / restart cycles. The
    // statusline subsequently updates locally via the /yolo and /perms
    // slash handlers below.
    approvalsMode: initialPermsMode,
    // v0.24.4: drives the statusbar gate that hides the sandbox-billing
    // balance segment + drives the /help copy below. See state.ts.
    isLocalGateway,
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

  const renderEvent = (kind: GatewayEventKind, data: unknown): void => {
    const d = data as Record<string, unknown>
    switch (kind) {
      case 'tool-call-start':
        state.pushRow({
          role: 'tool-call',
          text: '',
          toolName: String(d.name ?? '?'),
          args: String(d.args ?? ''),
          autoEscalated: d.autoEscalated === true,
        })
        break
      case 'tool-call-end':
        state.pushRow({
          role: 'tool-result',
          text: String(d.summary ?? (d.ok ? 'ok' : 'failed')),
          failed: d.ok === false,
          autoEscalated: d.autoEscalated === true,
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
      case 'context-compacted': {
        const from = Number(d.from ?? 0)
        const to = Number(d.to ?? 0)
        const tokens = Number(d.promptTokens ?? 0)
        const tokensHint = tokens > 0 ? ` (~${Math.round(tokens / 1000)}k tokens)` : ''
        state.pushRow({
          role: 'system',
          text: `✂︎ context compacted ${from} → ${to} messages${tokensHint}`,
        })
        break
      }
      case 'auto-topup': {
        const message = String(d.message ?? '')
        const kind = String(d.kind ?? '')
        const prefix =
          kind === 'topup-fired' ? '⚡ topup' : kind === 'wallet-low' ? '⚠ wallet' : '✗ topup'
        state.pushRow({ role: 'system', text: `${prefix}  ${message}` })
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
        } else if (k === 'telegram-inbound') {
          const who = d.username ? `@${d.username}` : `id=${d.userId ?? '?'}`
          state.pushRow({
            role: 'inbox-tg',
            text: `tg ${who} · ${d.preview ?? ''}`,
          })
        } else if (k === 'telegram-outbound') {
          state.pushRow({
            role: 'system',
            text: `tg out → chat ${d.chatId ?? '?'} · ${d.length ?? 0} chars`,
          })
        } else if (k === 'telegram-processing-start') {
          state.pushRow({
            role: 'system',
            text: `tg replying to chat ${d.chatId ?? '?'}`,
          })
        } else if (k === 'telegram-processing-end') {
          state.pushRow({
            role: 'system',
            text: d.ok
              ? `tg reply sent to chat ${d.chatId ?? '?'}`
              : `tg reply FAILED to chat ${d.chatId ?? '?'}`,
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
      for await (const ev of client.events({ signal: eventSignal.signal, clientKind: 'tui' })) {
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

  // v0.22.0: poll balances directly from chain. Sandbox-deployed agents still
  // have their EOA + compute ledger on-chain (agent privkey signs from inside
  // the container), and the sandbox billing reserve is read against the
  // settlement contract using the operator's address. All three queries are
  // read-only RPC and never touch the daemon, so they're safe at any moment.
  const balanceRpcNetwork = config.network as AnimaNetwork
  const balancePublicClient = createPublicClient({
    transport: http(NETWORK_RPC[balanceRpcNetwork]),
  })
  const operatorAddressForBilling = config.identity?.operator as Address | undefined
  const refreshBalances = (): void => {
    balancePublicClient
      .getBalance({ address: agentAddress })
      .then(wei => state.setEoaBalance(Number(formatEther(wei))))
      .catch(() => {})
    getLedgerDetailReadOnly({ network: balanceRpcNetwork, agentAddress })
      .then(detail => {
        if (detail) state.setBalance(Number(formatEther(detail.totalBalance)))
      })
      .catch(() => {})
    // v0.24.4: local-gateway deploys have no Daytona billing reserve to
    // surface — skip the RPC roundtrip entirely (saved 2 calls/min on the
    // 30s timer) and leave sandboxBalance() as null so the statusbar Show
    // gate hides the segment.
    if (!isLocalGateway && operatorAddressForBilling) {
      getSandboxBillingReserve({ recipient: operatorAddressForBilling })
        .then(wei => state.setSandboxBalance(Number(formatEther(wei))))
        .catch(() => {})
    }
  }
  refreshBalances()
  const balanceTimer = setInterval(refreshBalances, 30_000)

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
      // v0.22.0: chain ops drained balances; refresh statusline.
      refreshBalances()
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
    // v0.21.13: forward bypass commands to the gateway via client.chat() (the
    // gateway's dispatchBypass intercepts before brain.infer) AND optimistically
    // update the local statusline. Pre-fix the gateway updated its own
    // PermissionService but the TUI's hardcoded `approvalsMode: 'off'` never
    // moved, leaving the statusbar stuck at 'off' even after `/perms prompt`.
    if (cmd === '/yolo' || cmd === '/perms' || cmd.startsWith('/perms ')) {
      try {
        const r = await client.chat(cmd)
        state.pushRow({ role: 'assistant', text: r.response })
        // Re-read healthz for ground truth; cheap (~5ms) and immune to brain reply parsing.
        const h = await client.health().catch(() => null)
        const next = h?.permsMode
        if (next) state.setApprovalsMode(next)
      } catch (e) {
        state.pushRow({
          role: 'system',
          text: `${cmd} failed: ${(e as Error).message.slice(0, 200)}`,
        })
      }
      return true
    }
    if (cmd === '/reset') {
      try {
        const r = await client.chat(cmd)
        state.pushRow({ role: 'assistant', text: r.response })
      } catch (e) {
        state.pushRow({
          role: 'system',
          text: `reset failed: ${(e as Error).message.slice(0, 200)}`,
        })
      }
      return true
    }
    if (cmd === '/help') {
      // v0.24.4: differentiate the help copy. Local gateway mode flushes
      // memory directly to chain via the daemon; sandbox mode flushes via
      // the remote harness sitting in Daytona. Both share the same command
      // surface so the body is identical; only the prefix label differs.
      const modeLabel = isLocalGateway ? 'local gateway' : 'sandbox'
      const flushTarget = isLocalGateway ? 'via local gateway daemon' : 'via remote harness'
      state.pushRow({
        role: 'system',
        text: `${modeLabel}-mode slash commands:\n  /sync   force memory + activity flush ${flushTarget}\n  /yolo   toggle approval prompts off/on for this session\n  /perms <mode>  set permission mode (off|prompt|strict); no arg shows current\n  /reset  clear this channel's conversation history\n  /exit   quit (${isLocalGateway ? 'gateway daemon keeps running' : 'harness keeps running'})\n  /help   this message`,
      })
      return true
    }
    return false
  }

  const handleExit = (): void => {
    eventSignal.abort()
    clearInterval(balanceTimer)
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
