import { mkdir, readFile } from 'node:fs/promises'
import {
  ANIMA_AGENT_NFT_ADDRESS,
  ANIMA_INBOX_ADDRESS,
  ANIMA_MARKET_ADDRESS,
  ActivityLog,
  type AutoTopupEvent,
  AutoTopupManager,
  type BrainMessage,
  BrokerPool,
  HookBus,
  type Listener,
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
  SannClient,
  type SkillRef,
  ToolRegistry,
  VISION_PROVIDER_DEFAULTS,
  type VisionInferFn,
  applyPerms,
  applyYolo,
  buildFrozenPrefix,
  createFsHistoryPersist,
  derivePubkeyHex,
  detectFetchEscalation,
  iNFTAgentId,
  loadPlugins,
  makeMemoryReadTool,
  makeMemorySaveTool,
  makeToolSearchTool,
  makeViemClients,
  matchSkillTriggers,
  newEventId,
  readIndexFile,
  runEscalation,
  scanSkills,
} from '@s0nderlabs/anima-core'
import {
  type CommsRuntimeContext,
  type DeliveredMessage,
  type JobEvent,
  MARKETPLACE_GUIDANCE,
  type OperatorNotice,
} from '@s0nderlabs/anima-plugin-comms'
import { ONCHAIN_GUIDANCE, type OnchainRuntimeContext } from '@s0nderlabs/anima-plugin-onchain'
import {
  type ApprovalChoiceKind,
  type ParsedBypass,
  TELEGRAM_GUIDANCE,
  type TelegramApprovalBridge,
  type TelegramDispatchInput,
  type TelegramDispatchResult,
  type TelegramRuntimeContext,
  formatInboundPreview as formatTelegramInboundPreview,
  makeApprovalIdFactory,
  parseBypassCommand,
  stripTelegramChannelEnvelope,
} from '@s0nderlabs/anima-plugin-telegram'
import type { Address, Hex } from 'viem'
import type { ApprovalRelay } from './approval-relay'
import type { EventHub } from './events'
import { restoreMemoryFromChain } from './memory-restore'
import type { RuntimeConfig } from './runtime'
import type { GatewaySecrets } from './secrets'

export interface BuildRuntimeOpts {
  config: RuntimeConfig
  agentPrivkey: Hex
  agentAddress: Address
  agentDir: string
  events: EventHub
  approvals: ApprovalRelay
  /**
   * Optional: forwarded into PluginContext so plugins that read
   * `~/.anima/config.ts` know where to write back. The harness creates an
   * in-memory placeholder if not supplied (default `${agentDir}/.config-handle.ts`).
   */
  configPath?: string
  /**
   * Optional: workspace cwd for shell.run / code.execute / shell.process_*
   * plus the cwd field exposed to the brain via envInfo. Default
   * `process.cwd()`, matching local-mode chat.tsx. The bootstrap script does
   * `cd "$ANIMA_DIR"` (= `$HOME/anima` on Daytona) before launching the
   * harness, so process.cwd() already points at the cloned repo. Override
   * only for tests or a non-standard layout.
   */
  workspaceRoot?: string
  /**
   * Optional secrets shipped via the second provision envelope. When
   * `secrets.telegram` is present, the harness wires a telegram listener +
   * approval bridge so the operator can DM the bot from their phone and
   * approve tool calls via inline keyboard.
   */
  secrets?: GatewaySecrets
}

export interface BuiltRuntime {
  brain: OGComputeBrain
  tools: ToolRegistry
  permission: PermissionService
  hooks: HookBus
  sync: MemorySyncManager
  activity: ActivityLog
  listeners: Listener[]
  inboundQueue: DeliveredMessage[]
  marketBrainQueue: JobEvent[]
  knownJobs: Map<string, { buyer: Address; provider: Address }>
  buildPrefix: () => Promise<ReturnType<typeof buildFrozenPrefix>>
  refreshUserContext: () => Promise<void>
  dispose: () => Promise<void>
  agentId: string
  /** v0.21.0: optional auto-topup manager. Null when economy.autoTopup.enabled === false. */
  autoTopup: AutoTopupManager | null
}

const PERMISSION_MODE_MAP: Record<NonNullable<RuntimeConfig['permissions']>, PermissionMode> = {
  off: 'off',
  prompt: 'prompt',
  strict: 'strict',
  yolo: 'off',
}

/**
 * Resolve the user-facing agent name. Sourced from `config.subname` when
 * registered (e.g. "specter" for `specter.anima.0g`); falls back to a
 * `agent-<8 hex>` slug. Used by the TG pairing greeting so unknown DM users
 * see "Hi! I'm specter and I don't recognize you yet." instead of the slug.
 */
export function resolveAgentName(subname: string | null | undefined, agentId: string): string {
  const trimmed = typeof subname === 'string' ? subname.trim() : ''
  return trimmed.length > 0 ? trimmed : `agent-${agentId.slice(0, 8)}`
}

function describePermissionCheck(call: { name: string; args: unknown }): PermissionRequest | null {
  const a = (call.args ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  switch (call.name) {
    case 'shell.run':
      return { kind: 'shell.run', command: str(a.command), reason: 'shell command execution' }
    case 'code.execute':
      return {
        kind: 'code.execute',
        command: `[${str(a.language) || '?'}] ${str(a.code)}`,
        reason: 'arbitrary code execution',
      }
    case 'shell.process_start':
      return { kind: 'shell.process', command: str(a.command), reason: 'background process start' }
    case 'fs.write':
      return { kind: 'fs.write', path: str(a.path), reason: 'fs.write request' }
    case 'fs.patch':
      return { kind: 'fs.patch', path: str(a.path), reason: 'fs.patch request' }
    case 'chain.send':
      return {
        kind: 'chain.send',
        amount: optStr(a.amount) ?? '?',
        recipient: optStr(a.to) ?? '?',
        token: optStr(a.token) ?? '0G',
        reason: 'native/ERC-20 transfer',
      }
    case 'swap.execute':
      return {
        kind: 'chain.swap',
        amount: optStr(a.amountIn) ?? '?',
        token: `${optStr(a.tokenIn) ?? '?'}→${optStr(a.tokenOut) ?? '?'}`,
        reason: 'JAINE swap execution',
      }
    case 'chain.wrap':
      return {
        kind: 'chain.send',
        amount: optStr(a.amount) ?? '?',
        token: '0G→W0G',
        reason: 'wrap native to W0G',
      }
    case 'chain.unwrap':
      return {
        kind: 'chain.send',
        amount: optStr(a.amount) ?? '?',
        token: 'W0G→0G',
        reason: 'unwrap W0G to native',
      }
    case 'stake.stake':
      return {
        kind: 'chain.stake',
        amount: optStr(a.amount) ?? '',
        token: '0G→stOG',
        reason: 'Gimo stake',
      }
    case 'stake.unstake':
      return {
        kind: 'chain.stake',
        amount: optStr(a.amountStog) ?? '',
        token: 'stOG→0G (queued)',
        reason: 'Gimo unstake',
      }
    case 'stake.claim':
      return { kind: 'chain.stake', token: 'claim queued 0G', reason: 'Gimo claim' }
    case 'chain.write':
      return {
        kind: 'chain.write',
        recipient: optStr(a.to) ?? '?',
        command: optStr(a.signature) ?? '?',
        amount: optStr(a.value) ? `${optStr(a.value)} wei` : undefined,
        reason: 'arbitrary state-changing call',
      }
    default:
      return null
  }
}

async function readMemoryFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * Construct the full anima runtime (tools, brain, plugins, listeners, sync)
 * inside the sandbox harness. Mirrors `chat.tsx` local-mode setup minus the
 * TUI rendering layer; plugin events publish through the EventHub instead.
 *
 * Lifecycle:
 *   1. Build viem clients + comms/onchain ctx + plugins
 *   2. Construct PermissionService bridged to ApprovalRelay
 *   3. Build prefix + activity log + sync manager
 *   4. Init brain + start listeners (background)
 *   5. Returned object is the long-lived runtime handle real-runtime keeps
 */
export async function buildAnimaRuntime(opts: BuildRuntimeOpts): Promise<BuiltRuntime> {
  const { config, agentPrivkey, agentAddress, events, approvals } = opts
  const network = config.network
  const contractAddress = config.identity.iNFT.contract
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentId = iNFTAgentId({ contractAddress, tokenId })
  const agentDir = opts.agentDir
  const memoryDir = `${agentDir}/memory`
  const memoryIndexPath = `${agentDir}/memory/MEMORY.md`
  const activityLogPath = `${agentDir}/activity.jsonl`
  const configPath = opts.configPath ?? `${agentDir}/.config-handle.ts`
  const workspaceRoot = opts.workspaceRoot ?? process.cwd()

  await mkdir(memoryDir, { recursive: true })
  await mkdir(`${memoryDir}/agent`, { recursive: true })
  await mkdir(`${memoryDir}/user`, { recursive: true })

  // Phase 11.5: rehydrate anchored memory + activity-log from 0G Storage
  // before the brain reads its frozen prefix. Per-slot best-effort; missing
  // or failed slots log a warning but never block boot. Local non-empty
  // files always win, protecting writes that haven't flushed to chain yet.
  const restoreOutcomes = await restoreMemoryFromChain({
    network,
    contractAddress,
    tokenId,
    agentPrivkey,
    agentDir,
  })
  for (const o of restoreOutcomes) {
    if (o.status === 'restored') {
      events.publish('log', {
        level: 'info',
        message: `memory-restored: ${o.slot} → ${o.path} (${o.bytes} bytes)`,
      })
    } else if (o.status === 'failed') {
      events.publish('log', {
        level: 'warn',
        message: `memory-restore-failed: ${o.slot} (${o.reason})`,
      })
    }
  }

  // v0.22.0: lazy retry for boot-time restore failures. If any slot stayed
  // 'failed' after the 3-attempt in-boot retry (transient 0G Storage indexer
  // degradation), the next chat turn fires another `restoreMemoryFromChain`
  // call (single-flight). `restoreMemoryFromChain` is idempotent — already-
  // restored slots get `status: 'skipped', reason: 'local-wins'` and don't
  // re-download. Brain self-heals on the next turn when storage recovers.
  let pendingRestoreFailed = restoreOutcomes.some(o => o.status === 'failed')
  let lazyRestoreInFlight: Promise<void> | null = null
  const triggerLazyRestore = (): void => {
    if (!pendingRestoreFailed) return
    if (lazyRestoreInFlight) return
    lazyRestoreInFlight = restoreMemoryFromChain({
      network,
      contractAddress,
      tokenId,
      agentPrivkey,
      agentDir,
    })
      .then(outs => {
        const stillFailed = outs.some(o => o.status === 'failed')
        for (const o of outs) {
          if (o.status === 'restored') {
            console.warn(
              `[memory-restore] lazy-recovered slot=${o.slot} → ${o.path} (${o.bytes} bytes)`,
            )
          }
        }
        pendingRestoreFailed = stillFailed
      })
      .catch(err => {
        console.warn(`[memory-restore] lazy retry threw: ${(err as Error).message.slice(0, 200)}`)
      })
      .finally(() => {
        lazyRestoreInFlight = null
      })
  }

  // 1. ToolRegistry + memory tools
  const tools = new ToolRegistry(config.tools as Record<string, boolean> | undefined)
  tools.register(makeMemorySaveTool({ agentId }) as Parameters<typeof tools.register>[0])
  tools.register(makeMemoryReadTool({ agentId }) as Parameters<typeof tools.register>[0])
  tools.register(makeToolSearchTool(tools) as Parameters<typeof tools.register>[0])

  // 2. Permission service. Default sandbox mode = 'off' (yolo) for autonomous
  // runtime; operator can override via config.permissions = 'prompt' but must
  // stay online for the modal round-trip in that case.
  const permissionMode: PermissionMode = PERMISSION_MODE_MAP[config.permissions ?? 'off']
  const permission = new PermissionService({ mode: permissionMode })

  // Bridge prompter → ApprovalRelay → SSE event for operator's TUI to see.
  permission.setPrompter(async req => {
    const { promise } = approvals.request({
      kind: req.kind,
      command: req.command,
      path: req.path,
      amount: req.amount,
      recipient: req.recipient,
      token: req.token,
      reason: req.reason,
    })
    const decision = await promise
    if (decision === 'allow') return 'allow-once' as PermissionDecision
    if (decision === 'allow-session') return 'allow-session' as PermissionDecision
    return 'deny' as PermissionDecision
  })

  const hooks = new HookBus()
  hooks.add<PreToolCallContext, PreToolCallResult>('pre_tool_call', async ({ call }) => {
    const checks = describePermissionCheck(call)
    if (!checks) return undefined
    const result = await permission.resolve(checks)
    if (result.allowed) return undefined
    return {
      short: {
        ok: false,
        error: `Denied: ${result.reason ?? 'permission check failed'} (mode=${permission.getMode()}). Operator rejected this call. Do NOT retry, instruct another tool, or claim the transaction is queued.`,
      },
    }
  })

  // 3. Vision broker pool + viem clients
  const brokerPool = new BrokerPool({
    privkeyHex: agentPrivkey,
    rpcUrl: NETWORK_RPC[network],
  })
  const visionProvider = VISION_PROVIDER_DEFAULTS[network]
  const visionInfer: VisionInferFn | null = visionProvider
    ? brokerPool.visionInferFor(visionProvider)
    : null
  const viemClients = makeViemClients({ network, privkeyHex: agentPrivkey })

  // 4. Plugin filter + side-band ctxs (comms + onchain + telegram)
  const pluginNames = (config.plugins ?? ['system', 'comms', 'onchain']).filter(
    p => p === 'system' || p === 'comms' || p === 'onchain' || p === 'telegram',
  )

  const inboundQueue: DeliveredMessage[] = []
  const jobEventQueue: JobEvent[] = []
  let onInboundDeliver: (m: DeliveredMessage) => void = m => {
    inboundQueue.push(m)
  }
  let onInboundNotice: (n: OperatorNotice) => void = () => {}
  let onMarketJobEvent: (e: JobEvent) => void = e => {
    jobEventQueue.push(e)
  }

  let comms: CommsRuntimeContext | undefined
  let sann: SannClient | undefined
  if (pluginNames.includes('comms')) {
    const inboxAddress = ANIMA_INBOX_ADDRESS[network] as Address | undefined
    if (!inboxAddress) {
      throw new Error(`AnimaInbox missing for network=${network}`)
    }
    const marketAddress = ANIMA_MARKET_ADDRESS[network] as Address | undefined
    const ogStorage = new OGStorage({ network, privkeyHex: agentPrivkey })
    sann = new SannClient({ privkeyHex: agentPrivkey })
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
      ...(marketAddress
        ? {
            marketAddress,
            onJobEvent: (e: JobEvent) => onMarketJobEvent(e),
          }
        : {}),
    }
  }

  let onchain: OnchainRuntimeContext | undefined
  if (pluginNames.includes('onchain')) {
    onchain = {
      agentEoa: agentAddress,
      network,
      publicClient: viemClients.publicClient,
      walletClient: viemClients.walletClient,
      agentDir,
      mintBlock: 0n,
      iNFT: { contract: contractAddress, tokenId },
      brainProvider: config.brain.provider,
      brainModel: config.brain.model,
      subname: config.subname ?? null,
      // derivePubkeyHex emits SEC1 uncompressed `0x04 || x32 || y32`; strip the
      // 4-char `0x04` prefix to match the body form used in .anima.0g records.
      agentPubkey: derivePubkeyHex(agentPrivkey).slice(4),
      singletons: {
        inbox: ANIMA_INBOX_ADDRESS[network],
        market: ANIMA_MARKET_ADDRESS[network],
        agentNFT: ANIMA_AGENT_NFT_ADDRESS[network],
      },
      // v0.21.9: surface deployTarget + operator to account.balance so the
      // sandbox billing reserve lookup works under sandbox deployment.
      deployTarget: config.deployTarget ?? 'local',
      operatorAddress: config.identity.operator,
    }
  }

  // Phase 12 / B6: telegram side-band ctx for sandbox mode.
  // Closes G3 (the hollow telegram block in this file). The dispatcher mirrors
  // the chat-telegram local-mode pattern: forward inbound DMs through brain
  // with source='telegram', publish events to EventHub so chat-sandbox.tsx
  // renders the row, fire-and-forget per-turn sync. Approval bridge slots
  // are filled by listener.start() so the operator can approve tool calls
  // from their phone via inline keyboard.
  let telegram: TelegramRuntimeContext | undefined
  let telegramDispatchSlot: {
    current: ((i: TelegramDispatchInput) => Promise<TelegramDispatchResult>) | null
  } | null = null
  let telegramPendingApprovals: Map<string, (choice: ApprovalChoiceKind) => void> | null = null
  let telegramApprovalIdFactory: (() => string) | null = null
  let telegramApprovalBridge: TelegramApprovalBridge | null = null
  if (opts.secrets?.telegram && pluginNames.includes('telegram')) {
    const tg = opts.secrets.telegram
    telegramDispatchSlot = { current: null }
    telegramPendingApprovals = new Map()
    telegramApprovalIdFactory = makeApprovalIdFactory()
    telegramApprovalBridge = {
      sendApproval: { current: null },
      installCallbackHandler: { current: null },
    }
    const { PairingStore, agentPaths } = await import('@s0nderlabs/anima-core')
    // Use the canonical CLI-shared pairing path (~/.anima/agents/<id>/pairing)
    // so codes generated by the daemon are visible to `anima pairing approve`
    // running from the operator's machine. The daemon's tmp-scratch agentDir
    // (real-runtime's tmpdir/anima-gateway/<id>) is NOT the right location;
    // it diverges from where the CLI reads from.
    const pairingStore = new PairingStore({ dir: agentPaths.agent(agentId).pairingDir })
    telegram = {
      botToken: tg.botToken,
      allowedUserIds: tg.allowedUserIds,
      agentName: resolveAgentName(config.subname, agentId),
      pairingStore,
      dispatchUserMessage: async input => {
        const cb = telegramDispatchSlot?.current
        if (!cb) return { response: 'agent is still booting; try again in a moment.' }
        return cb(input)
      },
      onProcessingStart: async (chatId, msgId) => {
        events.publish('listener-event', {
          kind: 'telegram-processing-start',
          chatId,
          messageId: msgId,
        })
      },
      onProcessingEnd: async (chatId, msgId, ok) => {
        events.publish('listener-event', {
          kind: 'telegram-processing-end',
          chatId,
          messageId: msgId,
          ok,
        })
      },
      approvalBridge: telegramApprovalBridge,
    }
  }

  const collectedListeners: Listener[] = []
  const skillsDisabled = { current: [] as string[] }

  // Sub-brain factory for delegate.task. Mirrors chat.tsx: a fresh
  // OGComputeBrain on the same provider/model with a custom system prompt
  // and the requested tool subset. Without this the delegate.task tool
  // never registers (the plugin gates registration on ctx.delegateFactory).
  const delegateFactory: import('@s0nderlabs/anima-core').DelegateBrainFactory = async ({
    systemPrompt,
    tools: subTools,
  }) => {
    const subBrain = new OGComputeBrain({
      privkeyHex: opts.agentPrivkey,
      rpcUrl: NETWORK_RPC[network],
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

  // Resolver imports plugin packages directly (workspace deps; cycle-free).
  const loadResult = await loadPlugins(pluginNames, {
    tools,
    hooks,
    listeners: { register: l => collectedListeners.push(l) },
    agentDir,
    agentId,
    network,
    configPath,
    imports: { claudeCode: true },
    skillsDisabled,
    activityLogPath,
    workspaceRoot,
    claudeAgents: [],
    brainSupportsVision: false,
    brainModelLabel: config.brain.model ?? config.brain.provider,
    visionInfer,
    comms,
    onchain,
    telegram,
    delegateFactory,
    resolve: async name => {
      switch (name) {
        case 'system':
          return await import('@s0nderlabs/anima-plugin-system')
        case 'comms':
          return await import('@s0nderlabs/anima-plugin-comms')
        case 'onchain':
          return await import('@s0nderlabs/anima-plugin-onchain')
        case 'telegram':
          return await import('@s0nderlabs/anima-plugin-telegram')
        default:
          throw new Error(`unknown first-party plugin: ${name}`)
      }
    },
  })
  if (loadResult.errors.length > 0) {
    events.publish('log', {
      level: 'warn',
      message: `plugin-load-errors: ${loadResult.errors.map(e => `${e.plugin}=${e.error}`).join(', ')}`,
    })
  }

  // 5. MemorySyncManager + activity log + frozen prefix
  //
  // Path split that matters for /sync correctness:
  //   - `activityLogPath` is the DAEMON's runtime log (under TMPDIR) — the
  //     gateway appends every wake/tool-call/brain-response there, so /sync
  //     must read from this path to capture the live history.
  //   - `memoryDir` is intentionally OMITTED — memory.save + memory.read
  //     (both registered by plugin-system) resolve via `agentPaths.agent(id)`
  //     which lives under `~/.anima/agents/<id>/memory/`. Forcing the
  //     sync-manager to look elsewhere would upload a stale daemon-side
  //     snapshot and ignore the operator's actual saves.
  const sync = new MemorySyncManager({
    network,
    agentId,
    agentPrivkey,
    agentAddress,
    contractAddress,
    tokenId,
    activityLogPath,
  })
  const activity = new ActivityLog(activityLogPath)

  const [memoryIndex, identityText, personaText, scannedSkills] = await Promise.all([
    readIndexFile(memoryIndexPath).catch(() => null),
    readMemoryFileOrNull(`${memoryDir}/agent/identity.md`),
    readMemoryFileOrNull(`${memoryDir}/agent/persona.md`),
    scanSkills({ importsClaudeCode: true }).catch(() => [] as SkillRef[]),
  ])
  const skillsRef = { current: scannedSkills }

  const loadedToolNames = tools.list().map(t => t.name)
  const promptAppend = config.promptAppend ?? null
  const envInfo = {
    cwd: workspaceRoot,
    platform: process.platform,
    sandbox: {
      mode: 'docker' as const,
      label: '0g-sandbox-galileo (TDX TEE)',
      innerOs: 'linux' as const,
      workspaceMount: workspaceRoot,
      scope: 'sandbox-deploy',
    },
  }
  const extraGuidance: string[] = []
  if (comms?.marketAddress) extraGuidance.push(MARKETPLACE_GUIDANCE)
  if (onchain) extraGuidance.push(ONCHAIN_GUIDANCE)
  if (telegram) extraGuidance.push(TELEGRAM_GUIDANCE)

  const buildPrefix = async () => {
    // v0.22.0: re-read identity/persona/index each turn so a successful
    // lazy-retry restore lands in the next prompt without a daemon restart.
    // Also kick the lazy retry (single-flight) for any slot still missing.
    triggerLazyRestore()
    const [idx, identityFresh, personaFresh] = await Promise.all([
      readIndexFile(memoryIndexPath).catch(() => null),
      readMemoryFileOrNull(`${memoryDir}/agent/identity.md`),
      readMemoryFileOrNull(`${memoryDir}/agent/persona.md`),
    ])
    return buildFrozenPrefix({
      memoryIndex: idx,
      identity: identityFresh ?? identityText,
      persona: personaFresh ?? personaText,
      loadedToolNames,
      skills: skillsRef.current,
      promptAppend,
      envInfo,
      extraGuidance,
    })
  }
  const initialPrefix = buildFrozenPrefix({
    memoryIndex,
    identity: identityText,
    persona: personaText,
    loadedToolNames,
    skills: skillsRef.current,
    promptAppend,
    envInfo,
    extraGuidance,
  })

  // Skill auto-trigger
  const pendingSkillInjections = new Set<string>()
  hooks.add<PostToolCallContext, void>('post_tool_call', async ({ call, result }) => {
    if (result.ok === false) return
    const matches = matchSkillTriggers({ name: call.name, args: call.args }, skillsRef.current)
    for (const match of matches) {
      if (pendingSkillInjections.has(match.skill.id)) continue
      pendingSkillInjections.add(match.skill.id)
      events.publish('log', {
        level: 'info',
        message: `skill auto-loaded: ${match.skill.id} (matched ${match.reason})`,
      })
    }
  })

  // 6. Brain. onToolCall fires tool-call-start/end events on the EventHub so
  // the operator's TUI renders ▸/↳ indicators.
  const persistConversations = config.brain?.persistConversations !== false
  const brain = new OGComputeBrain({
    privkeyHex: agentPrivkey,
    rpcUrl: NETWORK_RPC[network],
    providerAddress: config.brain.provider,
    tools: tools.schemas(),
    prefix: initialPrefix,
    maxOutputTokens: config.brain?.maxOutputTokens,
    compaction:
      config.brain?.compaction === null
        ? null
        : {
            threshold: config.brain?.compaction?.threshold ?? 0.5,
            contextWindow: config.brain?.contextWindow ?? 1_000_000,
            keepRecent: config.brain?.compaction?.keepRecent ?? 8,
          },
    persist: persistConversations
      ? createFsHistoryPersist({ dir: `${agentDir}/conversations` })
      : undefined,
    onToolCall: async call => {
      const startedAt = Date.now()
      events.publish('tool-call-start', {
        name: call.name,
        args: summarizeArgs(call.args),
        callId: call.id,
      })
      const pre = await hooks.runPreToolCall({ call })
      if (pre.short) {
        const durationMs = Date.now() - startedAt
        await activity.append({
          ts: Date.now(),
          kind: 'tool-call',
          data: { call, result: pre.short, blocked: true },
        })
        events.publish('tool-call-end', {
          name: call.name,
          ok: pre.short.ok !== false,
          callId: call.id,
          durationMs,
          summary: summarizeToolResult(pre.short),
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
      const durationMs = Date.now() - startedAt
      events.publish('tool-call-end', {
        name: call.name,
        ok: result.ok !== false,
        callId: call.id,
        durationMs,
        summary: summarizeToolResult(result),
      })
      // v0.21.2 R1: see chat.tsx for paired logic. Gateway sinks are SSE
      // start/end events instead of TUI state rows; orchestration shared
      // via runEscalation.
      const escalation = detectFetchEscalation(effectiveCall, result)
      if (escalation.needed) {
        const merged = await runEscalation(escalation, result, {
          runPreCall: c => hooks.runPreToolCall({ call: c }),
          runPostCall: (c, r) => hooks.runPostToolCall({ call: c, result: r }),
          dispatch: c => tools.dispatch(c),
          appendActivity: (c, r) =>
            activity.append({
              ts: Date.now(),
              kind: 'tool-call',
              data: { call: c, result: r, autoEscalated: true },
            }),
          onStart: c =>
            events.publish('tool-call-start', {
              name: c.name,
              args: summarizeArgs(c.args),
              callId: c.id,
              autoEscalated: true,
            }),
          onEnd: (c, r, durationMs) =>
            events.publish('tool-call-end', {
              name: c.name,
              ok: r.ok !== false,
              callId: c.id,
              durationMs,
              summary: summarizeToolResult(r),
              autoEscalated: true,
            }),
        })
        return { role: 'tool', content: JSON.stringify(merged) } as BrainMessage
      }
      return { role: 'tool', content: JSON.stringify(result) } as BrainMessage
    },
  })

  await brain.init()

  // 6.5. Phase 12 telegram dispatch + approval bridge wiring. Slot must be
  // filled BEFORE listeners start so any inbound TG message that races sees
  // the real dispatcher, not the boot-time stub.
  if (telegram && telegramDispatchSlot && telegramPendingApprovals && telegramApprovalIdFactory) {
    const slot = telegramDispatchSlot
    const pending = telegramPendingApprovals
    const idFactory = telegramApprovalIdFactory
    let approvalCallbackInstalled = false
    const ensureApprovalCallback = (): void => {
      if (approvalCallbackInstalled) return
      const install = telegramApprovalBridge?.installCallbackHandler.current
      if (!install) return
      install((approvalId, choice, _fromUserId) => {
        const r = pending.get(approvalId)
        if (r) {
          pending.delete(approvalId)
          r(choice)
        }
      })
      approvalCallbackInstalled = true
    }
    slot.current = async input => {
      ensureApprovalCallback()
      // Strip the channel envelope ONCE for preview + bypass parsing. The brain
      // dispatch path further down still receives `input.text` with envelope
      // intact (source/chat/user context matters for brain reasoning).
      // v0.22.0: previously the strip lived inline in the preview build only,
      // leaving parseBypassCommand to see the wrapped text. That text starts
      // with `<channel ...>` not `/`, so `/yolo` `/perms` `/reset` from TG
      // silently fell through to the brain instead of intercepting.
      const innerText = stripTelegramChannelEnvelope(input.text)

      // Publish inbound event so chat-sandbox.tsx renders a row.
      events.publish('listener-event', {
        kind: 'telegram-inbound',
        chatId: input.chatId,
        userId: input.userId,
        username: input.username,
        displayName: input.displayName,
        preview: formatTelegramInboundPreview({
          chatId: input.chatId,
          username: input.username,
          displayName: input.displayName,
          text: innerText,
        }),
      })

      // v0.20.0: bypass commands intercepted BEFORE brain.infer. Mirrors the
      // chat-telegram.ts handleBypass flow so /yolo, /perms, /reset work in
      // sandbox + gateway-local mode, not just the legacy in-process TUI path.
      const bypass = parseBypassCommand(innerText)
      if (bypass) {
        const reply = await dispatchTelegramBypass(bypass, input.sessionKey, permission, brain)
        return { response: reply }
      }
      // Build a TG-aware prompter for this turn (closes over input.chatId).
      const previousMode = permission.getMode()
      const previousPrompterRef = (
        permission as unknown as {
          prompter: (req: PermissionRequest) => Promise<PermissionDecision>
        }
      ).prompter
      // Honor ANIMA_TG_YOLO=1 to skip the approval dance for end-to-end test
      // matrices and trusted-operator scenarios. The flag is read on each turn
      // so it can be flipped without restarting.
      const tgYolo = process.env.ANIMA_TG_YOLO === '1'
      const send = !tgYolo ? telegramApprovalBridge?.sendApproval.current : undefined
      if (send) {
        permission.setPrompter(async req => {
          const approvalId = idFactory()
          const body = `🔐 Approval needed for ${req.kind}\n\n${req.command ?? req.path ?? req.recipient ?? ''}\n\nReason: ${req.reason}`
          console.log(
            `[tg-approval] prompter invoked: id=${approvalId} kind=${req.kind} chat=${input.chatId}`,
          )
          return new Promise<PermissionDecision>(resolve => {
            const timeoutMs = 5 * 60_000
            const timer = setTimeout(() => {
              if (pending.delete(approvalId)) {
                console.log(`[tg-approval] TIMEOUT after ${timeoutMs}ms: id=${approvalId} → deny`)
                resolve('deny')
              }
            }, timeoutMs)
            pending.set(approvalId, choice => {
              console.log(`[tg-approval] resolver fired: id=${approvalId} choice=${choice}`)
              clearTimeout(timer)
              resolve(
                choice === 'once'
                  ? 'allow-once'
                  : choice === 'session' || choice === 'always'
                    ? 'allow-session'
                    : 'deny',
              )
            })
            void send(input.chatId, body, approvalId)
              .then(() => console.log(`[tg-approval] inline keyboard sent: id=${approvalId}`))
              .catch(err => {
                console.log(
                  `[tg-approval] inline keyboard send FAILED: id=${approvalId} err=${(err as Error).message?.slice(0, 100)}`,
                )
                clearTimeout(timer)
                if (pending.delete(approvalId)) resolve('deny')
              })
          })
        })
        // v0.22.0: respect a globally-set yolo (off) or strict mode. Previously
        // every TG turn unconditionally forced 'prompt', clobbering whatever
        // the operator set via /yolo or /perms strict. The finally-block at
        // the bottom of this turn handler still restores `previousMode`, so
        // the only effect of skipping the override here is honoring it during
        // the turn itself.
        if (previousMode !== 'off' && previousMode !== 'strict') {
          permission.setMode('prompt')
        }
      } else if (previousMode !== 'off') {
        permission.setMode('off')
      }
      try {
        await activity.append({
          ts: Date.now(),
          kind: 'wake',
          data: {
            source: 'telegram',
            chatId: input.chatId,
            userId: input.userId,
            text: input.text,
          },
        })
        const turn = await brain.infer({
          event: {
            id: newEventId(),
            source: 'telegram',
            payload: { label: 'telegram-message', data: input.text },
            ts: Date.now(),
          },
          channelKey: input.sessionKey,
          // Forward per-turn tool-call observer so the listener's
          // ProgressTracker can render a live progress message in TG. The
          // brain emits start/end events that the listener turns into
          // edits on a single scratch message (hermes-style).
          onToolEvent: input.onToolEvent
            ? ev => {
                input.onToolEvent?.({
                  kind: ev.kind,
                  tool: ev.tool,
                  callId: ev.callId,
                  argsPreview: ev.argsPreview,
                  ok: ev.ok,
                })
              }
            : undefined,
          onCompactionEvent: ev => {
            events.publish('context-compacted', ev)
            void activity
              .append({ ts: Date.now(), kind: 'context-compacted', data: ev })
              .catch(() => {})
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
            source: 'telegram',
          },
        })
        const response = (turn.content ?? '').trim()
        events.publish('listener-event', {
          kind: 'telegram-outbound',
          chatId: input.chatId,
          length: response.length,
        })
        // Fire-and-forget memory sync to 0G Storage. Mainnet finality can take
        // minutes; awaiting it would block the dispatch lock and stack up
        // queued telegram messages behind a single in-flight turn. Surfacing
        // the resulting tx via the listener-event channel keeps observability
        // for downstream consumers without blocking the reply.
        void sync
          .flushTurn()
          .then(r => {
            if (r.txHash) {
              events.publish('listener-event', {
                kind: 'sync-flush',
                source: 'telegram',
                chatId: input.chatId,
                txHash: r.txHash,
              })
            }
          })
          .catch(() => {
            /* swallow — sync errors should never block reply */
          })
        return { response: response.length === 0 ? '(no reply)' : response }
      } finally {
        permission.setMode(previousMode)
        if (send && previousPrompterRef) permission.setPrompter(previousPrompterRef)
      }
    }
  }

  // 7. Wire forward-declared listener callbacks now that everything's built.
  const knownJobs = new Map<string, { buyer: Address; provider: Address }>()
  const marketBrainQueue: JobEvent[] = []

  onInboundDeliver = m => {
    inboundQueue.push(m)
    events.publish('listener-event', {
      kind: 'a2a-delivered',
      from: m.from,
      fromLabel: m.fromLabel ?? null,
      txHash: m.txHash,
      preview: previewBody(m),
    })
  }
  onInboundNotice = notice => {
    events.publish('listener-event', {
      kind: 'a2a-notice',
      noticeKind: notice.kind,
      from: 'from' in notice ? notice.from : null,
      reason: 'reason' in notice ? notice.reason : null,
    })
  }
  onMarketJobEvent = e => {
    if (e.kind === 'created')
      knownJobs.set(e.jobId.toString(), { buyer: e.buyer, provider: e.provider })
    events.publish('listener-event', {
      kind: 'market-job',
      jobKind: e.kind,
      jobId: e.jobId.toString(),
      txHash: e.txHash,
    })
    marketBrainQueue.push(e)
  }

  // Drain anything queued during boot. The first deliverers only buffered
  // (no SSE); now that the EventHub-publishing deliverer is wired, replay
  // each through it so the operator's TUI sees the listener-event row.
  const bootInbound = inboundQueue.splice(0)
  for (const m of bootInbound) onInboundDeliver(m)
  while (jobEventQueue.length > 0) onMarketJobEvent(jobEventQueue.shift()!)

  // 8. Start gateway listeners in the background. Don't await; catch-up can
  // be slow and the harness needs to accept /chat immediately after Ready.
  for (const l of collectedListeners) {
    void l.start(undefined as never).catch(err => {
      events.publish('log', {
        level: 'error',
        message: `listener ${l.name} failed: ${(err as Error).message}`,
      })
    })
  }

  const dispose = async (): Promise<void> => {
    if (autoTopup) {
      try {
        autoTopup.stop()
      } catch {
        // best-effort
      }
    }
    for (const l of collectedListeners) {
      try {
        await l.stop?.()
      } catch {
        // best-effort
      }
    }
  }

  // v0.21.0: agent funds its own compute bills out of its EOA. Manager polls
  // the per-provider envelope and refills via depositFund + transferFund when
  // it drops below threshold. Notifications flow through `events` (TUI ✂︎-style
  // system row) and the activity log. Disabled when `economy.autoTopup.enabled
  // === false`.
  let autoTopup: AutoTopupManager | null = null
  const economyEnabled = config.economy?.autoTopup?.enabled !== false
  if (economyEnabled && config.brain?.provider) {
    const onAutoTopupEvent = (ev: AutoTopupEvent): void => {
      events.publish('auto-topup', ev)
      void activity.append({ ts: ev.ts, kind: 'auto-topup', data: ev }).catch(() => {})
    }
    autoTopup = new AutoTopupManager(
      {
        enabled: true,
        pollIntervalMs: config.economy?.autoTopup?.pollIntervalMs,
        compute: {
          provider: config.brain.provider as Address,
          lowThreshold: config.economy?.autoTopup?.compute?.lowThreshold,
          topUpAmount: config.economy?.autoTopup?.compute?.topUpAmount,
          maxPerDay: config.economy?.autoTopup?.compute?.maxPerDay,
        },
        wallet: {
          notifyThreshold: config.economy?.autoTopup?.wallet?.notifyThreshold,
          minRetainedAfterTopup: config.economy?.autoTopup?.wallet?.minRetainedAfterTopup,
        },
      },
      {
        agentAddress,
        publicClient: viemClients.publicClient,
        getBrokerLedger: async () => brain.getLedger(),
        // v0.21.5: wake the broker eagerly on the first null-ledger tick so
        // an idle agent (no chat turns yet) still autotopups its compute
        // envelope. brain.init() is idempotent; the second call short-
        // circuits via `if (this.broker) return`.
        getBrainInit: () => brain.init(),
        onEvent: onAutoTopupEvent,
      },
    )
    autoTopup.start()
  }

  return {
    brain,
    tools,
    permission,
    hooks,
    sync,
    activity,
    listeners: collectedListeners,
    inboundQueue,
    marketBrainQueue,
    knownJobs,
    buildPrefix,
    refreshUserContext: async () => {
      const next = await buildPrefix()
      brain.refreshUserContext(next)
    },
    dispose,
    agentId,
    autoTopup,
  }
}

function previewBody(m: DeliveredMessage): string {
  const env = m.envelope
  if (env.type === 'msg') return env.content.replace(/\s+/g, ' ').trim().slice(0, 120)
  return `[file] ${env.filename} (${env.size} bytes)`
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

function summarizeToolResult(result: unknown): string {
  const r = result as { ok?: boolean; error?: string; data?: { path?: string } } | null | undefined
  if (!r || r.ok === undefined) return 'done'
  if (r.ok === false) return (r.error ?? 'failed').slice(0, 200)
  const path = typeof r.data?.path === 'string' ? r.data.path : null
  return path ? path : 'ok'
}

/**
 * Mirror of chat-telegram.ts handleBypass for the gateway dispatch path.
 * Runs BEFORE brain.infer so /yolo, /perms, /reset operate without burning
 * compute. Returns the reply text the listener will deliver to the chat.
 */
async function dispatchTelegramBypass(
  bypass: ParsedBypass,
  sessionKey: string,
  permission: PermissionService,
  brain: OGComputeBrain,
): Promise<string> {
  switch (bypass.command) {
    case '/stop':
      return 'no active turn to stop in this dispatch path.'
    case '/new':
    case '/reset':
      try {
        await brain.clearChannel(sessionKey)
        return "conversation reset (this chat's history cleared)."
      } catch (err) {
        return `reset failed: ${(err as Error).message?.slice(0, 200) ?? 'unknown error'}`
      }
    case '/status':
      return 'idle.'
    case '/approve':
    case '/deny':
      return 'inline-keyboard approval is the supported path; click the buttons in the modal.'
    case '/yolo':
      return applyYolo(permission).message
    case '/perms':
      return applyPerms(permission, bypass.args[0]).message
    case '/background':
    case '/restart':
      return `${bypass.command} is reserved for a future bundle.`
  }
}
