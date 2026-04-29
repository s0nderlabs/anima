import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isCancel, select, spinner } from '@clack/prompts'
import {
  ANIMA_INBOX_ADDRESS,
  ActivityLog,
  type AnimaConfig,
  type BrainMessage,
  BrokerPool,
  type ClaudeAgent,
  type ClaudeCommand,
  HookBus,
  type Listener,
  LocalBackend,
  McpManager,
  MemorySyncManager,
  NETWORK_RPC,
  OGComputeBrain,
  OGStorage,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  PermissionService,
  type PostToolCallContext,
  type PreToolCallContext,
  type PreToolCallResult,
  type SandboxBackend,
  SannClient,
  type SkillRef,
  ToolRegistry,
  VISION_PROVIDER_DEFAULTS,
  type VisionInferFn,
  agentPaths,
  buildFrozenPrefix,
  discoverClaudeExtras,
  discoverMcpServers,
  explorerTxUrl,
  fetchAndDecryptKeystore,
  iNFTAgentId,
  loadPlugins,
  makeMemoryReadTool,
  makeMemorySaveTool,
  makeSandboxBackend,
  makeToolSearchTool,
  makeViemClients,
  matchSkillTriggers,
  newEventId,
  readIndexFile,
  scanSkills,
} from '@s0nderlabs/anima-core'
import {
  type CommsRuntimeContext,
  type DeliveredMessage,
  type OperatorNotice,
  ensureOwnPubkeyPublished,
} from '@s0nderlabs/anima-plugin-comms'
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
  // Claude Code extras (commands + agents) discovery happens BEFORE plugin
  // load so delegate.task can surface agents.
  let claudeCommands: ClaudeCommand[] = []
  let claudeAgents: ClaudeAgent[] = []
  try {
    const extras = await discoverClaudeExtras({
      importsClaudeCode: config.imports?.claudeCode ?? true,
    })
    claudeCommands = extras.commands
    claudeAgents = extras.agents
  } catch {
    // Discovery failed; continue without commands/agents.
  }
  const commandIndex = new Map<string, ClaudeCommand>()
  for (const cmd of claudeCommands) {
    if (!commandIndex.has(cmd.name)) commandIndex.set(cmd.name, cmd)
    if (!commandIndex.has(cmd.id)) commandIndex.set(cmd.id, cmd)
  }

  // Sub-brain factory for delegate.task (Phase 9.3). The factory creates a
  // fresh OGComputeBrain on the SAME provider/model with a custom system
  // prompt. Tools default to none for delegated work; the parent calls
  // delegate.task only when isolation matters.
  const delegateFactory: import('@s0nderlabs/anima-core').DelegateBrainFactory = async ({
    systemPrompt,
    tools: subTools,
  }) => {
    const subBrain = new OGComputeBrain({
      privkeyHex: agentPrivkey,
      rpcUrl: NETWORK_RPC[config.network],
      providerAddress: config.brain.provider!,
      tools: subTools,
      prefix: buildFrozenPrefix({
        systemPrompt,
        memoryIndex: null,
        identity: null,
        persona: null,
        loadedToolNames: [],
        skills: [],
        timestamp: null,
      }),
    })
    await subBrain.init()
    return subBrain as unknown as import('@s0nderlabs/anima-core').DelegateBrainHandle
  }

  // Phase 9.5: build sandbox backend BEFORE plugins load. Tools that spawn
  // subprocesses (shell.run, code.execute, shell.process_start) wrap their
  // spawn argv through this backend. ANIMA_SANDBOX_MODE env var wins over
  // config (matches hermes' TERMINAL_ENV pattern — per-launch override
  // without editing config).
  const envOverride = process.env.ANIMA_SANDBOX_MODE
  const sandboxMode: 'none' | 'os' | 'docker' =
    envOverride === 'none' || envOverride === 'os' || envOverride === 'docker'
      ? envOverride
      : (config.sandbox?.mode ?? 'none')
  let sandbox: SandboxBackend
  try {
    sandbox = makeSandboxBackend({
      mode: sandboxMode,
      agentDir: paths.dir,
      workspaceRoot: process.cwd(),
      homedir: homedir(),
      dockerImage: config.sandbox?.dockerImage,
      dockerMountWorkspace: config.sandbox?.dockerMountWorkspace,
      dockerRuntimePath: config.sandbox?.dockerRuntimePath,
      dockerCpu: config.sandbox?.dockerCpu,
      dockerMemoryMb: config.sandbox?.dockerMemoryMb,
      dockerDiskMb: config.sandbox?.dockerDiskMb,
      dockerNoNetwork: config.sandbox?.dockerNoNetwork,
    })
  } catch (err) {
    process.stderr.write(
      `anima: sandbox init failed (${(err as Error).message}), continuing without sandbox\n`,
    )
    sandbox = new LocalBackend()
  }
  if (sandbox.mode === 'os') {
    process.stderr.write(
      `anima: sandbox active [${sandbox.label}] — limb spawns gated to agentDir + cwd + /tmp/anima-* + /var/folders; reads of ~/.ssh ~/.aws ~/Library/Keychains ~/.config/gcloud denied\n`,
    )
  } else if (sandbox.mode === 'docker') {
    process.stderr.write(
      `anima: container sandbox active [${sandbox.label}] — every shell-class spawn runs inside the container; host fs invisible to those tools${config.sandbox?.dockerMountWorkspace ? ' except mounted /workspace' : ''}\n`,
    )
  }
  // Register dispose hook so docker containers don't leak when anima exits.
  // Signal handlers MUST await dispose before exiting; sync `process.exit(0)`
  // would discard the dispose promise and leave the container orphaned.
  if (sandbox.dispose) {
    const disposeOnce = (() => {
      let done = false
      return async () => {
        if (done) return
        done = true
        await sandbox.dispose?.().catch(() => {})
      }
    })()
    process.once('SIGINT', () => {
      void disposeOnce().then(() => process.exit(0))
    })
    process.once('SIGTERM', () => {
      void disposeOnce().then(() => process.exit(0))
    })
  }

  const brokerPool = new BrokerPool({
    privkeyHex: agentPrivkey,
    rpcUrl: NETWORK_RPC[config.network],
  })
  const visionProviderRaw = config.vision?.provider
  const visionProvider =
    visionProviderRaw === null
      ? null
      : (visionProviderRaw ?? VISION_PROVIDER_DEFAULTS[config.network])
  const visionInfer: VisionInferFn | null = visionProvider
    ? brokerPool.visionInferFor(visionProvider)
    : null

  // Plugin filter: system + comms ship today; onchain is empty.
  const pluginNames = (config.plugins ?? []).filter(p => p === 'system' || p === 'comms')
  // Phase 7 comms side-band ctx: viem clients + OGStorage adapter + SannClient +
  // AnimaInbox singleton + listener delivery callbacks. Skipped when 'comms'
  // isn't in the plugins list to avoid the eager construction cost.
  // onDeliver/onOperatorNotice are forward-declared as mutable cells so the ctx
  // can be built before state + brain exist; they get wired further below.
  const inboundQueue: DeliveredMessage[] = []
  let onInboundDeliver: (m: DeliveredMessage) => void = m => {
    inboundQueue.push(m)
  }
  let onInboundNotice: (n: OperatorNotice) => void = () => {}
  let comms: CommsRuntimeContext | undefined
  let sann: SannClient | undefined
  if (pluginNames.includes('comms')) {
    const inboxAddress = ANIMA_INBOX_ADDRESS[config.network] as Address | undefined
    if (!inboxAddress) {
      throw new Error(
        `AnimaInbox address missing for network=${config.network}; check core/identity/deployments.ts`,
      )
    }
    const viemClients = makeViemClients({ network: config.network, privkeyHex: agentPrivkey })
    const ogStorage = new OGStorage({ network: config.network, privkeyHex: agentPrivkey })
    sann = new SannClient({ privkeyHex: agentPrivkey })
    // Listener.catchUp fetches getBlockNumber itself; passing 0n here just
    // seeds an unset cursor so the first catch-up scans from chain head.
    const sannRead = sann
    comms = {
      agentEoa: agentAddress,
      agentPrivkeyHex: agentPrivkey,
      publicClient: viemClients.publicClient,
      walletClient: viemClients.walletClient,
      sann: { readText: (node, key) => sannRead.readText(node, key) },
      storage: {
        put: async bytes => (await ogStorage.putBlob(bytes)) as Hex,
        get: async dataHash => {
          const blob = await ogStorage.getBlob(dataHash)
          if (!blob) throw new Error(`storage: blob ${dataHash} not found`)
          return blob
        },
      },
      inboxAddress,
      startBlock: 0n,
      onDeliver: m => onInboundDeliver(m),
      onOperatorNotice: n => onInboundNotice(n),
    }
  }
  // Local listener registry: plugin-comms registers a single 'a2a-inbox'
  // listener via ctx.registerListener; we collect them here so chat can
  // start them once brain init is done. Other plugins may register listeners
  // too — same path.
  const collectedListeners: Listener[] = []
  const skillsDisabled = { current: [...(config.skills?.disabled ?? [])] }
  const loadResult = await loadPlugins(pluginNames, {
    tools,
    hooks,
    listeners: {
      register: l => {
        collectedListeners.push(l)
      },
    },
    agentDir: paths.dir,
    agentId,
    network: config.network,
    configPath,
    imports: { claudeCode: config.imports?.claudeCode ?? true },
    skillsDisabled,
    activityLogPath: paths.activityLog,
    workspaceRoot: process.cwd(),
    delegateFactory,
    claudeAgents,
    brainSupportsVision: false,
    brainModelLabel: config.brain.model ?? config.brain.provider,
    visionInfer,
    sandbox,
    comms,
    resolve: async name => {
      switch (name) {
        case 'system':
          return await import('@s0nderlabs/anima-plugin-system')
        case 'comms':
          return await import('@s0nderlabs/anima-plugin-comms')
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

  // MCP discovery: scan ~/.anima/.mcp.json + ~/.claude/.mcp.json + plugin
  // cache, spawn each stdio server, register tools as deferred. Failures are
  // logged but never block startup.
  let mcpManager: McpManager | null = null
  try {
    const { servers } = await discoverMcpServers({
      importsClaudeCode: config.imports?.claudeCode ?? true,
    })
    if (servers.length > 0) {
      mcpManager = new McpManager(servers)
      const mcpResult = await mcpManager.registerAll(def =>
        tools.register(def as Parameters<typeof tools.register>[0]),
      )
      if (mcpResult.failed.length > 0 || process.env.ANIMA_DEBUG_PLUGINS) {
        const { writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        await writeFile(
          join(paths.dir, 'mcp-debug.log'),
          JSON.stringify(
            { ts: Date.now(), servers: servers.map(s => s.name), result: mcpResult },
            null,
            2,
          ),
        ).catch(() => {})
      }
    }
  } catch {
    // Discovery itself failed (probably I/O); proceed without MCP.
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
  const [memoryIndex, identityText, personaText, scannedSkills] = await Promise.all([
    readIndexFile(paths.memoryIndex).catch(() => null),
    readMemoryFileOrNull(`${paths.memoryDir}/agent/identity.md`),
    readMemoryFileOrNull(`${paths.memoryDir}/agent/persona.md`),
    scanSkills({ importsClaudeCode: config.imports?.claudeCode ?? true }).catch(
      () => [] as SkillRef[],
    ),
  ])
  // Use tools.list() (includes deferred) for guidance lookup — guidance
  // fires per-tool-namespace, not per-prompt-schema. tools.schemas() is the
  // separate set the brain SEES in its prompt; deferred tools stay hidden
  // there until tool.search loads them. But the brain still needs to know
  // they EXIST via guidance, otherwise it never thinks to search.
  const loadedToolNames = tools.list().map(t => t.name)
  const disabledSkillSet = new Set(skillsDisabled.current)
  const skillsRef: { current: SkillRef[] } = {
    current: scannedSkills.filter(s => !disabledSkillSet.has(s.id)),
  }
  const promptAppend = config.prompt?.append ?? null
  // Surface sandbox awareness so the brain doesn't have to empirically discover
  // its container/profile via pwd + ls + uname round-trips. Without it,
  // qwen3.6-plus would hit fs.read('/workspace/X') → ENOENT (fs.* runs on host),
  // sed -i '' (BSD) → fails on Linux GNU sed, and answer "where am I?" only
  // after probing. Each wasted call costs latency + tokens.
  const envInfo = {
    cwd: process.cwd(),
    platform: process.platform,
    sandbox: sandbox.envHint?.() ?? null,
  }
  const buildPrefix = async () => {
    const idx = await readIndexFile(paths.memoryIndex).catch(() => null)
    return buildFrozenPrefix({
      memoryIndex: idx,
      identity: identityText,
      persona: personaText,
      loadedToolNames,
      skills: skillsRef.current,
      promptAppend,
      envInfo,
    })
  }
  const prefix = buildFrozenPrefix({
    memoryIndex,
    identity: identityText,
    persona: personaText,
    loadedToolNames,
    skills: skillsRef.current,
    promptAppend,
    envInfo,
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

  // Skills auto-trigger: when a tool call matches a skill's filePattern or
  // bashPattern, surface a system row so the operator sees the auto-load AND
  // queue the SKILL.md body for next-turn injection via brain.injectContext().
  const pendingSkillInjections = new Set<string>()
  hooks.add<PostToolCallContext, void>('post_tool_call', async ({ call, result }) => {
    if (result.ok === false) return
    const matches = matchSkillTriggers({ name: call.name, args: call.args }, skillsRef.current)
    for (const match of matches) {
      if (pendingSkillInjections.has(match.skill.id)) continue
      pendingSkillInjections.add(match.skill.id)
      state.pushRow({
        role: 'system',
        text: `↳ skill auto-loaded: ${match.skill.id} (matched ${match.reason}). use skills.view to read body.`,
      })
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

  // Initial ledger balance for the status bar (best-effort, never blocks boot).
  brain
    .getLedgerBalance()
    .then(b => {
      if (b != null) state.setBalance(b)
    })
    .catch(() => {})

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

  // ─── Inbound A2A queue + drain ────────────────────────────────────────────
  // Inbound messages arrive via plugin-comms's listener. We can't fire brain
  // turns concurrently with operator-typed prompts (single-flight gate), so
  // queue them and drain whenever status flips back to idle.
  let drainingInbound = false
  const drainInbound = async () => {
    if (drainingInbound) return
    if (inboundQueue.length === 0) return
    if (state.status() === 'thinking') return
    drainingInbound = true
    try {
      while (inboundQueue.length > 0) {
        const m = inboundQueue.shift()!
        const channelText = formatA2AChannel(m)
        state.pushRow({ role: 'inbox', text: formatInboxPreview(m) })
        state.setStatus('thinking')
        const abortCtrl = new AbortController()
        state.setActiveAbort(abortCtrl)
        try {
          const refreshed = await buildPrefix()
          brain.refreshUserContext(refreshed)
          await activity.append({
            ts: Date.now(),
            kind: 'wake',
            data: { source: 'a2a', from: m.from, txHash: m.txHash },
          })
          const turn = await brain.infer({
            event: {
              id: newEventId(),
              source: 'a2a',
              payload: { label: 'inbound-message', data: channelText, peer: m.from },
              ts: Date.now(),
            },
            signal: abortCtrl.signal,
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
          brain
            .getLedgerBalance()
            .then(b => {
              if (b != null) state.setBalance(b)
            })
            .catch(() => {})
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
            .catch(() => {})
        } catch (e) {
          if ((e instanceof Error && e.name === 'AbortError') || abortCtrl.signal.aborted) {
            state.pushRow({
              role: 'system',
              text: 'inbound a2a turn interrupted (esc).',
            })
            await activity.append({
              ts: Date.now(),
              kind: 'brain-response',
              data: { content: '(aborted by operator)', toolCalls: 0, finishReason: 'aborted' },
            })
            state.setStatus('idle')
          } else {
            state.pushRow({
              role: 'system',
              text: `inbound error: ${(e as Error).message.slice(0, 200)}`,
            })
            state.setStatus('idle')
          }
        } finally {
          state.setActiveAbort(null)
        }
      }
    } finally {
      drainingInbound = false
    }
  }
  // Wire forward-declared callbacks now that state + brain exist. Bound queue
  // (drops oldest with a system-row notice) prevents memory growth if a brain
  // turn wedges and inbound traffic spikes.
  const INBOUND_QUEUE_CAP = 100
  onInboundDeliver = m => {
    inboundQueue.push(m)
    if (inboundQueue.length > INBOUND_QUEUE_CAP) {
      const dropped = inboundQueue.shift()!
      state.pushRow({
        role: 'system',
        text: `inbound queue full (${INBOUND_QUEUE_CAP}); dropped oldest from ${shortAddr(dropped.from)}`,
      })
    }
    void drainInbound()
  }
  onInboundNotice = notice => {
    const msg = describeOperatorNotice(notice)
    if (msg) state.pushRow({ role: 'system', text: msg })
  }
  // Listener catch-up + WS subscribe runs in the background. `start` only
  // resolves after catch-up finishes, which can be slow on long-restored
  // agents; awaiting it would block the chat from accepting input.
  for (const l of collectedListeners) {
    l.start(undefined as never).catch(e => {
      state.pushRow({
        role: 'system',
        text: `listener ${l.name} failed to start: ${(e as Error).message.slice(0, 160)}`,
      })
    })
  }
  // Drain anything queued during boot.
  void drainInbound()

  // Phase 7 auto-publish: idempotent backfill of `<subname>.anima.0g pubkey`
  // text record. Fire-and-forget; failures don't block chat. Skipped without
  // comms (no SannClient) or without a configured subname.
  if (config.subname && sann) {
    const sannPub = sann
    ensureOwnPubkeyPublished({
      privkeyHex: agentPrivkey,
      subname: `${config.subname}.anima.0g`,
      sann: sannPub,
    })
      .then(res => {
        if (res.txHash) {
          state.pushRow({
            role: 'system',
            text: `pubkey published on ${config.subname}.anima.0g → ${explorerTxUrl(config.network, res.txHash)}`,
          })
        }
      })
      .catch(() => {})
  }

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
    // Per-turn AbortController. Esc in the TUI calls .abort() on this.
    // Stored on state so the keyboard handler can reach it from app.tsx.
    const abortCtrl = new AbortController()
    state.setActiveAbort(abortCtrl)
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
        signal: abortCtrl.signal,
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
      // Refresh balance fire-and-forget so the bar reflects post-turn burn.
      brain
        .getLedgerBalance()
        .then(b => {
          if (b != null) state.setBalance(b)
        })
        .catch(() => {})
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
      // AbortError = operator pressed Esc; render as a clean sys row, NOT an
      // error. The activity log gets a paired entry so the post-mortem reflects
      // operator intent, not a real fault.
      if ((e instanceof Error && e.name === 'AbortError') || abortCtrl.signal.aborted) {
        state.pushRow({
          role: 'system',
          text: 'turn interrupted (esc). brain stopped at the last completed step.',
        })
        await activity.append({
          ts: Date.now(),
          kind: 'brain-response',
          data: { content: '(aborted by operator)', toolCalls: 0, finishReason: 'aborted' },
        })
        state.setStatus('idle')
        return
      }
      // Mirror real errors to chat.log too — render-layer bugs can swallow the
      // sys row before it hits the screen, and chat.log is the only artifact
      // the operator can read post-mortem.
      const errMsg = e instanceof Error ? e.message : String(e ?? 'unknown error')
      const dumped = e instanceof Error ? (e.stack ?? e.message) : errMsg
      console.error('[handleSubmit] error:', dumped)
      state.pushRow({ role: 'system', text: `error: ${errMsg.slice(0, 300)}` })
      state.setStatus('error')
    } finally {
      state.setActiveAbort(null)
      // Inbound A2A events that arrived during this turn waited in the queue.
      // Drain once status flips back to idle.
      void drainInbound()
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
      const builtins =
        '  /sync   force memory + activity flush to 0G\n  /model  switch brain (run anima model after exiting)\n  /yolo   toggle approval prompts off/on for this session\n  /help   this message'
      const claudeBlock =
        commandIndex.size === 0
          ? ''
          : `\n\nClaude Code commands (auto-loaded):\n${[
              ...new Set([...commandIndex.values()].map(c => c.name)),
            ]
              .sort()
              .map(name => {
                const c = commandIndex.get(name)!
                return `  /${c.name}  ${c.description.slice(0, 80)}`
              })
              .join('\n')}`
      state.pushRow({
        role: 'system',
        text: `slash commands:\n${builtins}${claudeBlock}`,
      })
      return true
    }
    // Claude Code command match. Strip leading `/`, take first whitespace
    // segment as the command name, treat the rest as the user-supplied args.
    if (cmd.startsWith('/')) {
      const rest = cmd.slice(1).trim()
      if (!rest) return false
      const space = rest.indexOf(' ')
      const name = space === -1 ? rest : rest.slice(0, space)
      const args = space === -1 ? '' : rest.slice(space + 1).trim()
      const command = commandIndex.get(name)
      if (!command) return false
      const trimmedBody = command.body.trim()
      const inlined = args
        ? `# Command: /${command.name}${command.argumentHint ? ` (${command.argumentHint})` : ''}\n# User args: ${args}\n\n${trimmedBody}`
        : `# Command: /${command.name}\n\n${trimmedBody}`
      state.pushRow({
        role: 'system',
        text: `↳ command: /${command.name} (${command.id}, ${command.body.length} bytes inlined as user message)`,
      })
      // Send the command body as a user message so the brain executes it.
      try {
        const refreshed = await buildPrefix()
        brain.refreshUserContext(refreshed)
        const turn = await brain.infer({
          event: {
            id: newEventId(),
            source: 'stdin',
            payload: { label: 'user-message', data: inlined },
            ts: Date.now(),
          },
        })
        state.pushRow({ role: 'assistant', text: turn.content ?? '(no content)' })
        state.setStatus('idle')
      } catch (e) {
        state.pushRow({
          role: 'system',
          text: `command error: ${(e as Error).message.slice(0, 200)}`,
        })
      }
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
    try {
      mcpManager?.closeAll()
    } catch {}
    // Best-effort: kill any background processes registered via shell.process.
    try {
      const { killAllProcesses } = require('@s0nderlabs/anima-plugin-system') as {
        killAllProcesses: () => void
      }
      killAllProcesses()
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
  if (call.name === 'code.execute') {
    const args = (call.args ?? {}) as { code?: string; language?: string }
    const command = `[${args.language ?? '?'}] ${typeof args.code === 'string' ? args.code : ''}`
    return { kind: 'code.execute', command, reason: 'arbitrary code execution' }
  }
  if (call.name === 'shell.process_start') {
    const args = (call.args ?? {}) as { command?: string }
    const command = typeof args.command === 'string' ? args.command : ''
    return { kind: 'shell.process', command, reason: 'background process start' }
  }
  if (
    call.name === 'shell.process_output' ||
    call.name === 'shell.process_list' ||
    call.name === 'shell.process_kill'
  ) {
    return null
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

/**
 * Render an inbound A2A delivery as a `<channel>` block the brain treats as
 * untrusted external input (mirrors how attn/string surface remote agent
 * messages). Body content varies by envelope type: 'msg' carries the text,
 * 'file' carries filename + caption + a hint to call agent.fetchFile.
 */
/**
 * Single-line inbox preview shown to the operator when a new A2A message
 * arrives. Distinct from formatA2AChannel (which is the brain-facing block).
 * Format: `from short-addr · "first 80 chars of content"`.
 */
function formatInboxPreview(m: DeliveredMessage): string {
  const env = m.envelope
  const body =
    env.type === 'msg'
      ? env.content.replace(/\s+/g, ' ').trim()
      : `[file] ${env.filename} (${env.size} bytes)`
  const trimmed = body.length > 90 ? `${body.slice(0, 87)}...` : body
  return `from ${shortAddr(m.from)} · "${trimmed}"`
}

function formatA2AChannel(m: DeliveredMessage): string {
  const env = m.envelope
  const head = `<channel source="anima.inbox" from="${m.from}" txHash="${m.txHash}">`
  const body =
    env.type === 'msg'
      ? env.content
      : `[file] ${env.filename} (${env.mime}, ${env.size} bytes)${
          env.caption ? `\ncaption: ${env.caption}` : ''
        }\nfetch via agent.fetchFile data_hash=${m.dataHash}`
  const inReplyHint = env.inReplyTo ? `\n(reply to ${env.inReplyTo})` : ''
  return `${head}\n${body}${inReplyHint}\n</channel>`
}

/**
 * Translate a listener OperatorNotice into a one-line system row. Used for
 * pending-contact requests, rate-limit drops, and decrypt failures. Returns
 * null when the notice should be silently dropped from the UI.
 */
function describeOperatorNotice(n: OperatorNotice): string | null {
  switch (n.kind) {
    case 'pending-request':
      return `inbound a2a from ${shortAddr(n.from)} (not in contacts) — call agent.contact_add to approve, agent.block to refuse.`
    case 'rate-limit-drop':
      return `dropped repeated a2a from ${shortAddr(n.from)} (rate limit exceeded for non-contact).`
    case 'decrypt-failed':
      return `a2a decrypt failed from ${shortAddr(n.from)}: ${n.reason}`
    case 'fetch-failed':
      return `a2a storage fetch failed from ${shortAddr(n.from)}: ${n.reason}`
    default:
      return null
  }
}
