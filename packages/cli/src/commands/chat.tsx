import { mkdir } from 'node:fs/promises'
import { isCancel, select, spinner } from '@clack/prompts'
import {
  ActivityLog,
  type AnimaConfig,
  type BrainMessage,
  HookBus,
  MemorySyncManager,
  NETWORK_RPC,
  OGComputeBrain,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  PermissionService,
  type PreToolCallContext,
  type PreToolCallResult,
  ToolRegistry,
  agentPaths,
  buildFrozenPrefix,
  explorerTxUrl,
  fetchAndDecryptKeystore,
  iNFTAgentId,
  loadPlugins,
  makeMemoryReadTool,
  makeMemorySaveTool,
  makeToolSearchTool,
  newEventId,
  readIndexFile,
} from '@s0nderlabs/anima-core'
import { type Address, type Hex, formatEther } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export async function runChat(opts?: { cwd?: string; yolo?: boolean }): Promise<void> {
  const found = await findAndLoadConfig(opts?.cwd)
  if (!found) {
    console.log('No anima.config.ts found. Run `anima init` first.')
    process.exit(1)
  }
  let { config } = found
  const configPath = found.path

  if (!config.identity.iNFT || !config.identity.agent) {
    console.log('Config has no iNFT or agent yet. Re-run `anima init`.')
    process.exit(1)
  }
  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentId = iNFTAgentId({ contractAddress, tokenId })
  const paths = agentPaths.agent(agentId)
  const agentAddress = config.identity.agent as Address

  const operator = await loadOrPickOperatorSigner({
    network: config.network,
    hint: config.operator,
  })
  if (!operator) {
    console.log('No operator wallet available; cannot decrypt keystore.')
    process.exit(1)
  }

  const sUnlock = spinner()
  sUnlock.start('Fetching encrypted keystore + decrypting via operator wallet')
  let agentPrivkey: Hex
  try {
    const decrypted = await fetchAndDecryptKeystore({
      network: config.network,
      contractAddress,
      tokenId,
      signer: operator,
      agentAddress,
      cachePath: paths.keystore,
    })
    agentPrivkey = decrypted.privkeyHex
    sUnlock.stop(`unlocked (keystore source: ${decrypted.source})`)
  } catch (e) {
    sUnlock.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
    await operator.close?.()
    process.exit(1)
  }
  await operator.close?.()

  if (!config.brain.provider) {
    const updated = await runModelPicker(config, agentPrivkey, configPath)
    if (!updated) process.exit(1)
    config = updated
  }

  const tools = new ToolRegistry(config.tools)
  tools.register(makeMemorySaveTool({ agentId }) as Parameters<typeof tools.register>[0])
  tools.register(makeMemoryReadTool({ agentId }) as Parameters<typeof tools.register>[0])
  tools.register(makeToolSearchTool(tools) as Parameters<typeof tools.register>[0])

  const initialMode: PermissionMode = opts?.yolo ? 'off' : (config.approvals?.mode ?? 'prompt')
  const permission = new PermissionService({ mode: initialMode })
  const hooks = new HookBus()

  // Plugin failures are reported but do not abort startup; the brain still has
  // memory tools.
  //
  // The dynamic `import()` MUST happen from the CLI package context: that's
  // where the workspace deps `@s0nderlabs/anima-plugin-*` live. Passing this
  // resolver pins the import site to chat.tsx so bun's resolver finds them.
  const pluginNames = (config.plugins ?? []).filter(p => p === 'system')
  const loadResult = await loadPlugins(pluginNames, {
    tools,
    hooks,
    listeners: { register: () => {} },
    agentDir: paths.dir,
    agentId,
    network: config.network,
    resolve: async name => {
      switch (name) {
        case 'system':
          return await import('@s0nderlabs/anima-plugin-system')
        default:
          throw new Error(`unknown first-party plugin: ${name}`)
      }
    },
  })
  if (loadResult.errors.length > 0 || process.env.ANIMA_DEBUG_PLUGINS) {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(
      join(paths.dir, 'plugin-debug.log'),
      JSON.stringify(
        {
          ts: Date.now(),
          pluginNames,
          loadResult,
          registeredTools: tools.list().map(t => t.name),
        },
        null,
        2,
      ),
    ).catch(() => {})
  }

  const sync = new MemorySyncManager({
    network: config.network,
    agentId,
    agentPrivkey,
    agentAddress,
    contractAddress,
    tokenId,
  })
  // We deliberately skip `sync.init()`: it would seed lastPlaintextHash with
  // on-chain CIPHERTEXT hashes which never equal local plaintext hashes, so
  // the first flush would re-upload everything anyway. Letting plaintextHash
  // start empty produces the same one-time re-anchor on first flush, then
  // steady-state diffing kicks in without a wasted RPC call.

  await mkdir(paths.memoryDir, { recursive: true })
  const memoryIndex = await readIndexFile(paths.memoryIndex).catch(() => null)
  const identityText = await readMemoryFileOrNull(`${paths.memoryDir}/agent/identity.md`)
  const personaText = await readMemoryFileOrNull(`${paths.memoryDir}/agent/persona.md`)
  const loadedToolNames = tools.schemas().map(s => s.function.name)
  const buildPrefix = async () => {
    const idx = await readIndexFile(paths.memoryIndex).catch(() => null)
    return buildFrozenPrefix({
      memoryIndex: idx,
      identity: identityText,
      persona: personaText,
      loadedToolNames,
    })
  }
  const prefix = buildFrozenPrefix({
    memoryIndex,
    identity: identityText,
    persona: personaText,
    loadedToolNames,
  })
  const activity = new ActivityLog(paths.activityLog)

  // Brain init must happen BEFORE createCliRenderer. clack/prompts spinner
  // calls setRawMode(false) + stdin.pause() on stop, which undoes the
  // stdin.resume() that opentui's setupTerminal sets up. If brain init
  // (and its spinner) ran AFTER createCliRenderer, the stop would flip
  // stdin back into a state where opentui can't read keypresses, AND the
  // event loop would empty (no stdin keepalive) so the process exits.
  // The fix: every clack interaction finishes before opentui takes the wheel.
  const { render } = await import('@opentui/solid')
  const { createCliRenderer } = await import('@opentui/core')
  const { createChatState } = await import('../ui/state')
  const { ChatApp } = await import('../ui/app')

  const state = createChatState({
    initialSystem: opts?.yolo
      ? 'connected. YOLO mode: approval prompts disabled.'
      : 'connected. type messages and press enter.',
    identityLabel: `agent ${agentId}  ${shortAddr(agentAddress)}`,
    brainLabel: shortAddr(config.brain.provider!),
    approvalsMode: initialMode,
  })

  permission.setPrompter(req => {
    return new Promise<PermissionDecision>(resolve => {
      state.pushRow({
        role: 'system',
        text: `[approval requested] ${req.reason}: ${req.command ?? req.path ?? '(?)'}`,
      })
      state.setPendingApproval({ request: req, resolve })
    })
  })

  hooks.add<PreToolCallContext, PreToolCallResult>('pre_tool_call', async ({ call }) => {
    const checks = describePermissionCheck(call)
    if (!checks) return undefined
    const result = await permission.resolve(checks)
    if (result.allowed) return undefined
    return {
      short: {
        ok: false,
        error: `Denied by approval system: ${result.reason ?? 'no reason'} (mode=${permission.getMode()}).`,
      },
    }
  })

  const bootSpinner = spinner()
  bootSpinner.start(`Connecting to 0G Compute (${shortAddr(config.brain.provider!)})`)
  const brain = new OGComputeBrain({
    privkeyHex: agentPrivkey,
    rpcUrl: NETWORK_RPC[config.network],
    providerAddress: config.brain.provider!,
    tools: tools.schemas(),
    prefix,
    onToolCall: async call => {
      state.pushRow({
        role: 'tool-call',
        text: '',
        toolName: call.name,
        args: summarizeArgs(call.args),
      })
      const pre = await hooks.runPreToolCall({ call })
      if (pre.short) {
        await activity.append({
          ts: Date.now(),
          kind: 'tool-call',
          data: { call, result: pre.short, blocked: true },
        })
        state.pushRow({
          role: 'tool-result',
          text: summarizeToolResult(pre.short),
          failed: pre.short.ok === false,
        })
        return { role: 'tool', content: JSON.stringify(pre.short) } as BrainMessage
      }
      const effectiveCall = pre.call ?? call
      const result = await tools.dispatch(effectiveCall)
      await hooks.runPostToolCall({ call: effectiveCall, result })
      await activity.append({
        ts: Date.now(),
        kind: 'tool-call',
        data: { call: effectiveCall, result },
      })
      state.pushRow({
        role: 'tool-result',
        text: summarizeToolResult(result),
        failed: result.ok === false,
      })
      return {
        role: 'tool',
        content: JSON.stringify(result),
      } as BrainMessage
    },
  })
  try {
    await brain.init()
    bootSpinner.stop('Connected')
  } catch (e) {
    bootSpinner.stop(`Connection failed: ${(e as Error).message.slice(0, 120)}`)
    process.exit(1)
  }

  // Redirect noisy SDK chatter (0G storage progress, ethers RPC errors) to a
  // log file so it doesn't fall through opentui's alt-screen and pollute the
  // chat UI. Keep process.stdout intact - opentui itself needs to write there.
  const { createWriteStream } = await import('node:fs')
  const chatLog = createWriteStream(`${paths.dir}/chat.log`, { flags: 'a' })
  const stringifyArg = (a: unknown): string => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return a.stack ?? a.message
    try {
      return JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))
    } catch {
      return String(a)
    }
  }
  const logTo =
    (level: string) =>
    (...args: unknown[]) => {
      const line = args.map(stringifyArg).join(' ')
      chatLog.write(`[${new Date().toISOString()}] [${level}] ${line}\n`)
    }
  console.log = logTo('log') as typeof console.log
  console.warn = logTo('warn') as typeof console.warn
  console.error = logTo('error') as typeof console.error
  console.info = logTo('info') as typeof console.info
  console.debug = logTo('debug') as typeof console.debug
  process.on('unhandledRejection', err => {
    chatLog.write(`[unhandled] ${(err as Error)?.stack ?? String(err)}\n`)
  })

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    consoleMode: 'disabled',
    openConsoleOnError: false,
  })

  const handleSubmit = async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed.startsWith('/')) {
      const handled = await handleSlash(trimmed)
      if (handled) {
        // Slash commands skip brain.infer; reset thinking → idle so the
        // spinner row stops. (The keyboard handler in app.tsx flips
        // status='thinking' on every Enter, regardless of payload.)
        state.setStatus('idle')
        return
      }
    }
    try {
      // Refresh per-turn user-context (MEMORY.md may have grown last turn).
      // The system prefix stays cached; only the user-msg context updates.
      const refreshed = await buildPrefix()
      brain.refreshUserContext(refreshed)
      await activity.append({
        ts: Date.now(),
        kind: 'wake',
        data: { source: 'stdin', text },
      })
      const turn = await brain.infer({
        event: {
          id: newEventId(),
          source: 'stdin',
          payload: { label: 'user-message', data: text },
          ts: Date.now(),
        },
      })
      await activity.append({
        ts: Date.now(),
        kind: 'brain-response',
        data: {
          content: turn.content,
          toolCalls: turn.toolCalls.length,
          finishReason: turn.finishReason,
          usage: turn.usage,
        },
      })
      state.pushRow({ role: 'assistant', text: turn.content ?? '(no content)' })
      state.setStatus('idle')
      if (turn.usage) {
        state.setUsage({
          total: turn.usage.totalTokens,
          cached: turn.usage.cachedTokens,
        })
      }
      // Per-turn auto-sync: upload changed memory + activity-log to 0G Storage,
      // anchor in iNFT. Fire-and-forget; chat doesn't wait. Errors surface
      // as a system row every turn — repetition is the signal that a real
      // upstream issue persists, not noise to suppress.
      sync
        .flushTurn()
        .then(res => {
          if (res.txHash && res.changedSlots.length > 0) {
            state.pushRow({
              role: 'system',
              text: `synced ${res.changedSlots.join(', ')} → ${explorerTxUrl(config.network, res.txHash)}`,
            })
          }
        })
        .catch(e => {
          state.pushRow({
            role: 'system',
            text: `sync error: ${summarizeError(e)}`,
          })
        })
    } catch (e) {
      // Mirror the error to chat.log too — render-layer bugs can swallow the
      // sys row before it hits the screen, and chat.log is the only artifact
      // the operator can read post-mortem.
      const errMsg = e instanceof Error ? e.message : String(e ?? 'unknown error')
      const dumped = e instanceof Error ? (e.stack ?? e.message) : errMsg
      console.error('[handleSubmit] error:', dumped)
      state.pushRow({ role: 'system', text: `error: ${errMsg.slice(0, 300)}` })
      state.setStatus('error')
    }
  }

  const handleSlash = async (cmd: string): Promise<boolean> => {
    if (cmd === '/model') {
      state.pushRow({
        role: 'system',
        text: 'Switching brain. (Quit chat first; run `anima model` to pick a new brain, then re-launch `anima`.)',
      })
      return true
    }
    if (cmd === '/sync') {
      state.pushRow({ role: 'system', text: 'force-syncing memory + activity to 0G…' })
      try {
        const res = await sync.flushAll()
        if (res.txHash) {
          state.pushRow({
            role: 'system',
            text: `synced ${res.changedSlots.join(', ')} → ${explorerTxUrl(config.network, res.txHash)}`,
          })
        } else {
          state.pushRow({ role: 'system', text: 'nothing to sync (everything up to date)' })
        }
      } catch (e) {
        state.pushRow({ role: 'system', text: `sync error: ${summarizeError(e)}` })
      }
      return true
    }
    if (cmd === '/yolo') {
      const next: PermissionMode = permission.getMode() === 'off' ? 'prompt' : 'off'
      permission.setMode(next)
      state.setApprovalsMode(next)
      state.pushRow({
        role: 'system',
        text:
          next === 'off'
            ? 'YOLO ON. Approval prompts disabled this session. (run /yolo again to re-enable.)'
            : 'YOLO OFF. Dangerous commands now prompt for approval.',
      })
      return true
    }
    if (cmd === '/help') {
      state.pushRow({
        role: 'system',
        text: 'slash commands:\n  /sync   force memory + activity flush to 0G\n  /model  switch brain (run anima model after exiting)\n  /yolo   toggle approval prompts off/on for this session\n  /help   this message',
      })
      return true
    }
    return false
  }

  // @opentui/solid's render() resolves once the component mounts; it does not
  // block. On macOS the renderer's animation loop runs in a worker thread, so
  // the main thread has no JS task keeping the event loop alive after render
  // returns. Anchor: a never-resolving promise after render(); handleExit is
  // the only escape via process.exit.
  const handleExit = (): void => {
    try {
      renderer.destroy()
    } catch {}
    // Best-effort drain: if a flush is mid-flight, await it. Caps at 30s so
    // we never hang the CLI on a wedged RPC.
    Promise.race([sync.flushTurn(), new Promise(r => setTimeout(r, 30_000))]).finally(() =>
      process.exit(0),
    )
  }

  await render(
    () => <ChatApp state={state} onSubmit={handleSubmit} onExit={handleExit} />,
    renderer,
  )

  await new Promise<void>(() => {
    // Block forever; only handleExit (via process.exit) escapes this.
  })
}

async function runModelPicker(
  config: AnimaConfig,
  agentPrivkey: Hex,
  configPath: string,
): Promise<AnimaConfig | null> {
  const s = spinner()
  s.start('Fetching live 0G Compute catalog')
  let services: Awaited<ReturnType<typeof OGComputeBrain.listServicesFor>> = []
  try {
    services = await OGComputeBrain.listServicesFor({
      privkeyHex: agentPrivkey,
      rpcUrl: NETWORK_RPC[config.network],
    })
    s.stop(`Fetched ${services.length} services`)
  } catch (e) {
    s.stop(`Catalog fetch failed: ${(e as Error).message.slice(0, 120)}`)
    return null
  }
  if (services.length === 0) return null

  const picked = await select({
    message: 'Pick a brain (model)',
    options: services.map(svc => ({
      value: svc.provider,
      label: `${svc.model ?? '?'}  ${svc.serviceType ? `[${svc.serviceType}]` : ''}  ${shortAddr(svc.provider)}`,
      hint: svc.inputPrice
        ? `in ${formatEther(BigInt(svc.inputPrice))}/tok · out ${formatEther(BigInt(svc.outputPrice ?? 0n))}/tok`
        : undefined,
    })),
  })
  if (isCancel(picked) || typeof picked !== 'string') return null

  const model = services.find(s => s.provider === picked)?.model ?? null
  const updated: AnimaConfig = {
    ...config,
    brain: { provider: picked, model },
  }
  await writeConfigTs(configPath, updated)
  return updated
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/**
 * Squash a ToolResult down to a single-line summary for the chat row. The TUI
 * adds the `⎿` indent + color from the role, so this returns just the content:
 *   - failed   → the error message (truncated)
 *   - ok+path  → the file path the tool acted on
 *   - ok+data  → "ok"
 *   - done     → "done" (legacy: pre-ok results)
 */
function summarizeToolResult(result: unknown): string {
  const r = result as { ok?: boolean; error?: string; data?: { path?: string } } | null | undefined
  if (!r || r.ok === undefined) return 'done'
  if (r.ok === false) return (r.error ?? 'failed').slice(0, 200)
  const path = typeof r.data?.path === 'string' ? r.data.path : null
  return path ? path : 'ok'
}

/**
 * Squash an Error into a single-line, length-capped string for the TUI.
 * ethers / viem multi-line stack traces blow up the chat UX otherwise.
 * Strategy: collapse whitespace, drop everything after the first ` (action=`
 * marker (where ethers appends transaction blobs), cap at 90 chars so the
 * row stays on one terminal line in any reasonably-sized pane.
 */
function summarizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  let s = raw.replace(/\s+/g, ' ').trim()
  const annotIdx = s.indexOf(' (action=')
  if (annotIdx >= 0) s = s.slice(0, annotIdx)
  return s.length > 90 ? `${s.slice(0, 87)}...` : s
}

function describePermissionCheck(call: { name: string; args: unknown }): PermissionRequest | null {
  if (call.name === 'shell.run') {
    const args = (call.args ?? {}) as { command?: string }
    const command = typeof args.command === 'string' ? args.command : ''
    return { kind: 'shell.run', command, reason: 'shell command execution' }
  }
  if (call.name === 'fs.write' || call.name === 'fs.patch') {
    const args = (call.args ?? {}) as { path?: string }
    const path = typeof args.path === 'string' ? args.path : ''
    return { kind: call.name, path, reason: `${call.name} request` }
  }
  return null
}

function summarizeArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return String(args ?? '').slice(0, 60)
  const entries = Object.entries(args as Record<string, unknown>)
  return entries
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}=${s.length > 40 ? `${s.slice(0, 40)}…` : s}`
    })
    .slice(0, 3)
    .join(', ')
}

async function readMemoryFileOrNull(path: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    return await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
