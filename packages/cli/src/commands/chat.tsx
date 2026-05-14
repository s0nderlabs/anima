import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isCancel, select, spinner } from '@clack/prompts'
import {
  ANIMA_INBOX_ADDRESS,
  ANIMA_MARKET_ADDRESS,
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
  applyPerms,
  applyYolo,
  buildFrozenPrefix,
  createFsHistoryPersist,
  detectFetchEscalation,
  discoverClaudeExtras,
  discoverMcpServers,
  explorerTxUrl,
  fetchAndDecryptKeystore,
  iNFTAgentId,
  isOperatorSessionComplete,
  isOperatorSessionFresh,
  loadPlugins,
  makeMemoryListTool,
  makeMemoryReadTool,
  makeMemorySaveTool,
  makeSandboxBackend,
  makeToolSearchTool,
  makeViemClients,
  matchSkillTriggers,
  newEventId,
  readIndexFile,
  requiredScopesForAgent,
  runEscalation,
  scanSkills,
} from '@s0nderlabs/anima-core'
import {
  type CommsRuntimeContext,
  type DeliveredMessage,
  type JobEvent,
  MARKETPLACE_GUIDANCE,
  type OperatorNotice,
  ensureOwnPubkeyPublished,
  formatJobEvent,
  formatJobEventForBrain,
  isParticipant,
  jobEventShouldWakeBrain,
} from '@s0nderlabs/anima-plugin-comms'
import {
  ONCHAIN_GUIDANCE,
  type OnchainRuntimeContext,
  discoverMintBlock,
} from '@s0nderlabs/anima-plugin-onchain'
import {
  TELEGRAM_GUIDANCE,
  type TelegramApprovalBridge,
  type TelegramRuntimeContext,
  formatInboundPreview as formatTelegramInboundPreview,
} from '@s0nderlabs/anima-plugin-telegram'
import { type Address, type Hex, formatEther } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { shortAddr } from '../util/format'
import { loadTelegramSecrets, telegramSecretsExist } from '../util/telegram-secrets'
import {
  type TelegramDispatchSlot,
  buildTelegramDispatch,
  buildTelegramRuntimeContext,
} from './chat-telegram'
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
  // Phase 11: deployTarget=sandbox routes the chat loop to a thin client of
  // the harness HTTP server. The agent's privkey lives only inside the
  // container, so we skip keystore decrypt here.
  if (config.deployTarget === 'sandbox' && config.sandbox?.endpoint) {
    const { runChatSandbox } = await import('./chat-sandbox')
    return runChatSandbox(config)
  }
  // Phase 14: if a local gateway daemon is running for this agent (socket
  // present at ~/.anima/agents/<id>/gateway.sock), route to the same thin
  // client over a unix socket. The TUI no longer holds the runtime — the
  // gateway daemon does. Closing the TUI doesn't stop the listeners.
  //
  // v0.21.5: when no daemon is running but an operator session is fresh,
  // AUTO-SPAWN the daemon as a child process and attach as thin-client.
  // Without this, embedded TUI fallthrough silently disables (a) Telegram
  // pairing-store wiring (no inbound delivery) and (b) AutoTopupManager
  // polling. ANIMA_FORCE_EMBEDDED=1 escape hatch keeps the legacy path
  // available for tests / debugging.
  {
    const _contractAddr = config.identity.iNFT.contract as Address
    const _tokId = BigInt(config.identity.iNFT.tokenId)
    const _aid = iNFTAgentId({ contractAddress: _contractAddr, tokenId: _tokId })
    const _gatewaySock = join(agentPaths.agent(_aid).dir, 'gateway.sock')
    const forceEmbedded = process.env.ANIMA_FORCE_EMBEDDED === '1'
    let _socketExisted = existsSync(_gatewaySock)
    if (_socketExisted) {
      // v0.23.2: if the running daemon's version differs from the on-disk
      // CLI binary's version, the operator just ran `bun add -g @s0nderlabs/anima@N`
      // and expects the new behavior. Auto-restart the daemon so resume always
      // resolves to the latest version.
      const { ensureGatewayVersionMatchesCli } = await import('../util/gateway-version')
      const { createHash } = await import('node:crypto')
      const _identityHash = createHash('sha256').update(_aid).digest('hex').slice(0, 16)
      const _lockFile = join(homedir(), '.anima', 'locks', `anima-gateway-${_identityHash}.lock`)
      const drift = await ensureGatewayVersionMatchesCli({
        socketPath: _gatewaySock,
        lockFile: _lockFile,
      })
      if (drift.action === 'ok' || drift.action === 'no-cli-version') {
        const { runChatSandbox } = await import('./chat-sandbox')
        return runChatSandbox(config, { unixSocketPath: _gatewaySock })
      }
      console.log(`note: ${drift.note}`)
      _socketExisted = false
    }
    if (!_socketExisted && !forceEmbedded) {
      // v0.21.12: only auto-spawn the gateway daemon when the cached session
      // contains every scope key the daemon will need. A "fresh by ts" session
      // missing the TELEGRAM scope causes the daemon to silently drop all
      // inbound TG (the regression we shipped this fix to close). When
      // incomplete, fall through to the embedded path with a hint to run
      // `anima gateway start` interactively.
      const required = requiredScopesForAgent(_aid)
      if (isOperatorSessionComplete(_aid, required)) {
        const { spawnGatewayDaemon } = await import('../util/gateway-spawn')
        const sBoot = spinner()
        sBoot.start('Starting gateway daemon (auto-spawn)')
        try {
          const result = await spawnGatewayDaemon({
            agentId: _aid,
            configPath: configPath ?? '',
            socketPath: _gatewaySock,
            timeoutMs: 12_000,
          })
          if (result.ready) {
            sBoot.stop(`gateway running pid=${result.pid}`)
            const { runChatSandbox } = await import('./chat-sandbox')
            return runChatSandbox(config, { unixSocketPath: _gatewaySock })
          }
          const reason = result.reason ?? 'unknown'
          const detail = result.error ? `: ${result.error}` : ''
          sBoot.stop(
            `gateway auto-spawn failed (${reason}${detail}); falling back to embedded mode`,
          )
        } catch (err) {
          sBoot.stop(
            `gateway auto-spawn errored: ${(err as Error).message?.slice(0, 160)}; falling back to embedded mode`,
          )
        }
      } else if (isOperatorSessionFresh(_aid)) {
        // Session timestamp fresh but missing a required scope key (e.g.
        // telegram-secrets.encrypted exists on disk but the cached session
        // was written without TELEGRAM). Auto-spawning would produce a
        // daemon that silently drops TG. Make the operator re-run gateway
        // start interactively for full Touch ID derivation.
        const missing = required.filter(
          s =>
            !isOperatorSessionComplete(_aid, [
              s as ReturnType<typeof requiredScopesForAgent>[number],
            ]),
        )
        console.log(
          `note: cached operator-session is missing scope key(s) [${missing.join(', ')}] — run \`anima gateway start\` to re-derive via Touch ID. Continuing in embedded mode.`,
        )
      } else {
        // No session at all → operator must run `anima gateway start` for the
        // full daemon path (Touch ID + scope-key derivation). Print a hint.
        console.log(
          'note: gateway daemon would unlock TG + auto-topup; run `anima gateway start` to enable. Continuing in embedded mode.',
        )
      }
    }
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

  // Phase 12: decrypt telegram-secrets blob (if any) using the SAME operator
  // signer we already have unlocked. Avoids a second keychain prompt later.
  // We only attempt this if the operator opted in via `anima telegram setup`
  // (presence of the encrypted blob); the plugin opt-in is independent and
  // checked again below at plugin filter time.
  let telegramSecrets: Awaited<ReturnType<typeof loadTelegramSecrets>> = null
  if (telegramSecretsExist(agentId) && (config.plugins ?? []).includes('telegram')) {
    const sTg = spinner()
    sTg.start('Decrypting telegram secrets')
    try {
      telegramSecrets = await loadTelegramSecrets({ signer: operator, agentAddress, agentId })
      sTg.stop(`telegram unlocked (bot @${telegramSecrets?.botUsername ?? '?'})`)
    } catch (e) {
      sTg.stop(`telegram decrypt failed: ${(e as Error).message.slice(0, 160)}`)
      // Soft-fail: telegram is opt-in. Boot continues without it.
    }
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
  if (config.identity.iNFT) {
    tools.register(
      makeMemoryListTool({
        agentId,
        network: config.network,
        contractAddress: config.identity.iNFT.contract as `0x${string}`,
        tokenId: BigInt(config.identity.iNFT.tokenId),
      }) as Parameters<typeof tools.register>[0],
    )
  }
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

  // Plugin filter: system + comms + onchain all ship; telegram is opt-in via
  // `anima telegram setup` which writes ~/.anima/agents/<id>/telegram-secrets.encrypted
  // and adds 'telegram' to config.plugins.
  const pluginNames = (config.plugins ?? []).filter(
    p => p === 'system' || p === 'comms' || p === 'onchain' || p === 'telegram',
  )
  // viem clients live above the comms gate so the agent-EOA balance refresher
  // works regardless of whether the comms plugin is loaded.
  const viemClients = makeViemClients({ network: config.network, privkeyHex: agentPrivkey })
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
  // Phase 8: market events buffered the same way until UI mounts.
  const jobEventQueue: JobEvent[] = []
  let onMarketJobEvent: (e: JobEvent) => void = e => {
    jobEventQueue.push(e)
  }
  // Phase 10 onchain side-band ctx: viem clients (already built above) +
  // agent EOA + iNFT mint block (used as Transfer-event scan floor). Pre-
  // Phase-10 configs lack `mintBlock`; we backfill at chat boot by querying
  // the iNFT contract's ERC-721 Transfer logs for `tokenId` from `0x0` and
  // persist the value back to ~/.anima/config.ts so subsequent runs skip it.
  let onchain: OnchainRuntimeContext | undefined
  if (pluginNames.includes('onchain')) {
    const iNFT = config.identity.iNFT
    if (!iNFT) {
      throw new Error('plugin-onchain requires identity.iNFT in config')
    }
    let mintBlock = iNFT.mintBlock ? BigInt(iNFT.mintBlock) : null
    if (mintBlock === null) {
      mintBlock = await discoverMintBlock(viemClients.publicClient, contractAddress, tokenId)
      if (mintBlock !== null) {
        const updated: typeof config = {
          ...config,
          identity: {
            ...config.identity,
            iNFT: { ...iNFT, mintBlock: mintBlock.toString() },
          },
        }
        await writeConfigTs(configPath, updated, { subname: config.subname })
        config = updated
      }
    }
    onchain = {
      agentEoa: agentAddress,
      network: config.network,
      publicClient: viemClients.publicClient,
      walletClient: viemClients.walletClient,
      agentDir: paths.dir,
      mintBlock: mintBlock ?? 0n,
      iNFT: { contract: contractAddress, tokenId },
      brainProvider: config.brain.provider,
      brainModel: config.brain.model,
      // v0.21.9: account.balance reads these to surface sandbox billing reserve
      // for sandbox-deployed agents. Local mode just keeps deployTarget='local'
      // and skips the sandbox billing reserve section.
      deployTarget: (config.deployTarget ?? 'local') as 'local' | 'sandbox',
      operatorAddress: config.identity.operator as Address | undefined,
    }
  }
  let comms: CommsRuntimeContext | undefined
  let sann: SannClient | undefined
  if (pluginNames.includes('comms')) {
    const inboxAddress = ANIMA_INBOX_ADDRESS[config.network] as Address | undefined
    if (!inboxAddress) {
      throw new Error(
        `AnimaInbox address missing for network=${config.network}; check core/identity/deployments.ts`,
      )
    }
    const marketAddress = ANIMA_MARKET_ADDRESS[config.network] as Address | undefined
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
      ...(marketAddress
        ? {
            marketAddress,
            onJobEvent: (e: JobEvent) => onMarketJobEvent(e),
          }
        : {}),
    }
  }

  // Phase 12: telegram side-band ctx. We build the runtime context now (before
  // brain.init) so the plugin can register its listener via ctx.registerListener,
  // but the dispatch callback is deferred — the slot's `.current` is null until
  // brain.init resolves and we wire it below. Same for the system-row sink:
  // populated once state exists.
  const telegramSlot: TelegramDispatchSlot = { current: null }
  const telegramSystemRowSink: { current: ((text: string) => void) | null } = { current: null }
  const telegramInboundRowSink: { current: ((text: string) => void) | null } = { current: null }
  const telegramAssistantRowSink: { current: ((text: string) => void) | null } = { current: null }
  // Bridge for inline-keyboard approval. Listener fills the inner refs on
  // start; chat-telegram's runOne reads them at turn time.
  const telegramApprovalBridge: TelegramApprovalBridge = {
    sendApproval: { current: null },
    installCallbackHandler: { current: null },
  }
  let telegram: TelegramRuntimeContext | undefined
  if (telegramSecrets && pluginNames.includes('telegram')) {
    telegram = buildTelegramRuntimeContext({
      botToken: telegramSecrets.botToken,
      allowedUserIds: telegramSecrets.allowedUserIds,
      agentName: config.subname ?? `agent-${agentId.slice(0, 8)}`,
      slot: telegramSlot,
      systemRowSink: telegramSystemRowSink,
    })
    telegram.approvalBridge = telegramApprovalBridge
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
    onchain,
    telegram,
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
  // Plugin-contributed prompt sections. plugin-comms ships marketplace
  // guidance only when AnimaMarket is actually wired (marketAddress set);
  // gating on `comms?.marketAddress` keeps the prefix lean for non-market
  // sessions and avoids paying tokens for unreachable behavior.
  const extraGuidance: string[] = []
  if (comms?.marketAddress) extraGuidance.push(MARKETPLACE_GUIDANCE)
  if (onchain) extraGuidance.push(ONCHAIN_GUIDANCE)
  if (telegram) extraGuidance.push(TELEGRAM_GUIDANCE)

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
      extraGuidance,
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
    extraGuidance,
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
    // v0.22.0: show .0g subname when registered, fall back to the 16-char
    // agent ID hash. Use the FULL agent EOA (no shortAddr) so operators see
    // the complete address — useful for chain explorers + auto-topup audits.
    // Brain provider address dropped from statusline entirely; it had been
    // visual noise nobody acted on. Brain identity surfaces via singletons
    // in the frozen prefix and /healthz.brainProvider for operators.
    identityLabel: `agent ${config.subname ?? agentId}  ${agentAddress}`,
    approvalsMode: initialMode,
    // v0.24.4: embedded chat runs in-process on the operator's machine — by
    // definition local. Tag it so the statusbar hides the sandbox-billing
    // segment, matching the standalone-local-gateway path.
    isLocalGateway: true,
  })

  // Phase 12: now that state exists, point the telegram row sinks at it. The
  // dispatch slot stays null until brain.init resolves below.
  if (telegram) {
    telegramSystemRowSink.current = (text: string) => state.pushRow({ role: 'system', text })
    telegramInboundRowSink.current = (text: string) => state.pushRow({ role: 'inbox-tg', text })
    telegramAssistantRowSink.current = (text: string) =>
      state.pushRow({ role: 'telegram-assistant', text })
  }

  // Statusline balance refreshers; fired at boot, post-turn, and post-/sync.
  const refreshEoaBalance = () => {
    viemClients.publicClient
      .getBalance({ address: agentAddress })
      .then(wei => state.setEoaBalance(Number(formatEther(wei))))
      .catch(() => {})
  }
  const refreshBalances = () => {
    brain
      .getLedgerBalance()
      .then(b => {
        if (b != null) state.setBalance(b)
      })
      .catch(() => {})
    refreshEoaBalance()
  }

  permission.setPrompter(req => {
    return new Promise<PermissionDecision>(resolve => {
      // Value-moving onchain ops carry amount/recipient/token so we render a
      // friendlier "send 0.05 0G to 0xC635...87Ec" instead of a raw command.
      const detail =
        req.amount !== undefined
          ? `${req.amount}${req.token ? ` ${req.token}` : ''}${req.recipient ? ` to ${req.recipient}` : ''}`
          : (req.command ?? req.path ?? '(?)')
      state.pushRow({
        role: 'system',
        text: `[approval requested] ${req.reason}: ${detail}`,
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
        error: `Denied: ${result.reason ?? 'permission check failed'} (mode=${permission.getMode()}). Operator rejected this call. Do NOT retry, instruct another tool, or claim the transaction is queued. Surface the rejection to the operator and ask whether to proceed differently.`,
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
  const persistConversations = config.brain?.persistConversations !== false
  const brain = new OGComputeBrain({
    privkeyHex: agentPrivkey,
    rpcUrl: NETWORK_RPC[config.network],
    providerAddress: config.brain.provider!,
    tools: tools.schemas(),
    prefix,
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
      ? createFsHistoryPersist({ dir: `${paths.dir}/conversations` })
      : undefined,
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
      // v0.21.2 R1: deterministic browser.navigate retry when web.fetch hits
      // a bot-block. Mirror block in build-runtime.ts; both share orchestration
      // via runEscalation so any future change lands in one place. Sinks differ:
      // TUI pushes rows here, gateway publishes SSE events.
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
            state.pushRow({
              role: 'tool-call',
              text: '',
              toolName: c.name,
              args: summarizeArgs(c.args),
              autoEscalated: true,
            }),
          onEnd: (_c, r) =>
            state.pushRow({
              role: 'tool-result',
              text: summarizeToolResult(r),
              failed: r.ok === false,
              autoEscalated: true,
            }),
        })
        return { role: 'tool', content: JSON.stringify(merged) } as BrainMessage
      }
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

  // Phase 12: brain is up. Wire the deferred TG dispatch slot so any inbound
  // TG message that lands once collectedListeners[i].start() fires below
  // routes through brain.infer with source=telegram.
  if (telegram) {
    const handle = buildTelegramDispatch({
      activity,
      sync,
      permission,
      pushAssistantRow: text => telegramAssistantRowSink.current?.(text),
      pushInboundRow: text => telegramInboundRowSink.current?.(text),
      isBusy: () => state.status() === 'thinking',
      buildPrefix,
      brain,
      setThinking: on => state.setStatus(on ? 'thinking' : 'idle'),
      setActiveAbort: ctrl => state.setActiveAbort(ctrl),
      refreshBalances,
      formatInboundPreview: input =>
        formatTelegramInboundPreview({
          chatId: input.chatId,
          username: input.username,
          displayName: input.displayName,
          text: input.text.replace(/^<channel[^>]*>([\s\S]*)<\/channel>$/, '$1'),
        }),
      approvalBridge: telegramApprovalBridge,
    })
    telegramSlot.current = handle.dispatch
    // Drain queued TG messages whenever the brain returns to idle (closes G4
    // starvation: a stdin turn ending while a TG message was queued used to
    // leave it stuck until the next inbound).
    state.onStatusChange(next => {
      if (next === 'idle' && handle.getQueueSize() > 0) handle.drainQueue()
    })
  }

  // Initial balances for the status bar (best-effort, never blocks boot).
  refreshBalances()

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
  // ─── Market job-event drain (Phase 8) ─────────────────────────────────────
  // Mirrors drainInbound but for AnimaMarket events. Same single-flight gate.
  let drainingMarket = false
  const drainMarketEvents = async () => {
    if (drainingMarket) return
    if (marketBrainQueue.length === 0) return
    if (state.status() === 'thinking') return
    drainingMarket = true
    try {
      while (marketBrainQueue.length > 0) {
        const e = marketBrainQueue.shift()!
        const channelText = formatJobEventForBrain(e)
        state.setStatus('thinking')
        const abortCtrl = new AbortController()
        state.setActiveAbort(abortCtrl)
        try {
          const refreshed = await buildPrefix()
          brain.refreshUserContext(refreshed)
          await activity.append({
            ts: Date.now(),
            kind: 'wake',
            data: { source: 'market', kind: e.kind, jobId: e.jobId.toString(), txHash: e.txHash },
          })
          const turn = await brain.infer({
            event: {
              id: newEventId(),
              source: 'marketplace',
              payload: { label: `market:${e.kind}`, data: channelText },
              ts: Date.now(),
            },
            channelKey: 'marketplace',
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
          refreshBalances()
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
        } catch (err) {
          if ((err instanceof Error && err.name === 'AbortError') || abortCtrl.signal.aborted) {
            state.pushRow({ role: 'system', text: 'market turn interrupted (esc).' })
            state.setStatus('idle')
          } else {
            state.pushRow({
              role: 'system',
              text: `market turn error: ${(err as Error).message.slice(0, 200)}`,
            })
            state.setStatus('idle')
          }
        } finally {
          state.setActiveAbort(null)
        }
      }
    } finally {
      drainingMarket = false
    }
  }

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
        // Inbox row is rendered at delivery time in `onInboundDeliver`; the
        // listener can fire mid-turn, so display ≠ brain wake-up. Here we just
        // wake the brain on the message that's been queued.
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
            channelKey: `a2a:${m.from}`,
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
          refreshBalances()
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
    // Render the inbox row at delivery time, regardless of brain state.
    // Display is independent of the single-flight brain wake-up below: a
    // listener event during a long thinking turn must still appear in the
    // operator's transcript, even if the brain wakeup waits its turn.
    state.pushRow({ role: 'inbox', text: formatInboxPreview(m) })
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
  // Phase 8: every market event for a job we're a party to renders a system
  // row. Wake fires for every event we can react to except when we're the
  // identifiable actor (already saw the tool response). String's pattern at
  // `string/plugin/src/server.ts:887-958` is the reference.
  const marketBrainQueue: JobEvent[] = []
  const knownJobs = new Map<string, { buyer: Address; provider: Address }>()
  const handleJobEvent = (e: JobEvent) => {
    if (e.kind === 'created') {
      knownJobs.set(e.jobId.toString(), { buyer: e.buyer, provider: e.provider })
    }
    const job = knownJobs.get(e.jobId.toString()) ?? null
    if (!isParticipant(agentAddress, e, job)) return
    state.bumpActiveJobs(e)
    state.pushRow({ role: 'market', text: formatJobEvent(e) })
    if (jobEventShouldWakeBrain(e, agentAddress, job)) {
      marketBrainQueue.push(e)
      void drainMarketEvents()
    }
  }
  onMarketJobEvent = handleJobEvent
  // Drain queued job events (catch-up may have fired them before UI mounted).
  while (jobEventQueue.length > 0) {
    handleJobEvent(jobEventQueue.shift()!)
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
        channelKey: 'tui:stdin',
        signal: abortCtrl.signal,
        onCompactionEvent: ev => {
          state.pushRow({
            role: 'system',
            text: `✂︎ context compacted (${ev.from} → ${ev.to} messages, ~${Math.round(ev.promptTokens / 1000)}K tokens)`,
          })
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
      // Compute ledger drains via inference; agent EOA via tool chain writes.
      refreshBalances()
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
    if (cmd === '/exit' || cmd === '/quit') {
      state.pushRow({ role: 'system', text: 'goodbye.' })
      handleExit()
      return true
    }
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
          refreshEoaBalance()
        } else {
          state.pushRow({ role: 'system', text: 'nothing to sync (everything up to date)' })
        }
      } catch (e) {
        state.pushRow({ role: 'system', text: `sync error: ${summarizeError(e)}` })
      }
      return true
    }
    if (cmd === '/yolo') {
      const result = applyYolo(permission)
      state.setApprovalsMode(result.mode)
      state.pushRow({ role: 'system', text: result.message })
      return true
    }
    if (cmd === '/perms' || cmd.startsWith('/perms ')) {
      const arg = cmd.split(/\s+/)[1]
      const result = applyPerms(permission, arg)
      state.setApprovalsMode(result.mode)
      state.pushRow({ role: 'system', text: result.message })
      return true
    }
    if (cmd === '/reset') {
      try {
        await brain.clearChannel('tui:stdin')
        state.pushRow({ role: 'system', text: 'conversation reset (TUI channel cleared)' })
      } catch (e) {
        state.pushRow({ role: 'system', text: `reset error: ${summarizeError(e)}` })
      }
      return true
    }
    if (cmd === '/jobs') {
      const tool = tools.find('market.listMyJobs')
      if (!tool) {
        state.pushRow({
          role: 'system',
          text: 'market plugin not loaded; cannot list jobs.',
        })
        return true
      }
      state.pushRow({ role: 'system', text: 'fetching active jobs…' })
      try {
        const res = await tool.handler({ status: 'active', limit: 20 } as never)
        const data = (res as { ok: boolean; data?: { jobs: unknown[] } }).data
        const jobs = (data?.jobs ?? []) as Array<{
          jobId: string
          role: string
          counterparty: string | null
          amount0g: string
          status: string
        }>
        if (jobs.length === 0) {
          state.pushRow({ role: 'system', text: 'no active escrow jobs.' })
        } else {
          const lines = jobs.map(
            j =>
              `  job#${j.jobId} · ${j.role}${j.counterparty ? ` w/ ${shortAddr(j.counterparty)}` : ''} · ${j.amount0g} 0G · ${j.status}`,
          )
          state.pushRow({
            role: 'system',
            text: `active jobs (${jobs.length}):\n${lines.join('\n')}`,
          })
        }
      } catch (e) {
        state.pushRow({ role: 'system', text: `jobs error: ${summarizeError(e)}` })
      }
      return true
    }
    if (cmd === '/help') {
      const builtins =
        "  /sync                force memory + activity flush to 0G\n  /jobs                list active escrow jobs\n  /model               switch brain (run anima model after exiting)\n  /yolo                toggle approval prompts off/on for this session\n  /perms <mode>        set permission mode (off|prompt|strict); no arg shows current\n  /reset               clear this channel's conversation history\n  /exit                quit anima (drains 0G storage flush, releases process)\n  /help                this message"
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
          channelKey: 'tui:stdin',
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

  // Map Claude Code commands into SlashCommand shape so the slash
  // autocomplete popup lists them alongside the bundled registry.
  const extraSlashCommands = [...new Set([...commandIndex.values()].map(c => c.name))].map(name => {
    const c = commandIndex.get(name)!
    return {
      name: c.name.toLowerCase(),
      description: c.description ?? `Claude Code command (${c.id})`,
      surfaces: ['tui'] as ('tui' | 'tg')[],
      scope: 'local' as const,
      bypassesBrain: false,
      argHint: c.argumentHint,
    }
  })

  await render(
    () => (
      <ChatApp
        state={state}
        onSubmit={handleSubmit}
        onExit={handleExit}
        extraSlashCommands={extraSlashCommands}
      />
    ),
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

type PermArgs = Record<string, unknown>
const _str = (v: unknown): string => (typeof v === 'string' ? v : '')
const _strOpt = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const PERMISSION_DESCRIBERS: Record<string, (a: PermArgs) => PermissionRequest | null> = {
  'shell.run': a => ({
    kind: 'shell.run',
    command: _str(a.command),
    reason: 'shell command execution',
  }),
  'code.execute': a => ({
    kind: 'code.execute',
    command: `[${_str(a.language) || '?'}] ${_str(a.code)}`,
    reason: 'arbitrary code execution',
  }),
  'shell.process_start': a => ({
    kind: 'shell.process',
    command: _str(a.command),
    reason: 'background process start',
  }),
  'shell.process_output': () => null,
  'shell.process_list': () => null,
  'shell.process_kill': () => null,
  'fs.write': a => ({ kind: 'fs.write', path: _str(a.path), reason: 'fs.write request' }),
  'fs.patch': a => ({ kind: 'fs.patch', path: _str(a.path), reason: 'fs.patch request' }),
  // Phase 10: value-moving on-chain tools. Pre-fill amount/recipient/token
  // so the modal renders "send 0.05 0G to 0xC635..." not a raw command.
  'chain.send': a => ({
    kind: 'chain.send',
    amount: _strOpt(a.amount) ?? '?',
    recipient: _strOpt(a.to) ?? '?',
    token: _strOpt(a.token) ?? '0G',
    reason: 'native/ERC-20 transfer',
  }),
  'swap.execute': a => ({
    kind: 'chain.swap',
    amount: _strOpt(a.amountIn) ?? '?',
    token: `${_strOpt(a.tokenIn) ?? '?'}→${_strOpt(a.tokenOut) ?? '?'}`,
    reason: 'JAINE swap execution',
  }),
  'chain.wrap': a => ({
    kind: 'chain.send',
    amount: _strOpt(a.amount) ?? '?',
    token: '0G→W0G',
    reason: 'wrap native to W0G',
  }),
  'chain.unwrap': a => ({
    kind: 'chain.send',
    amount: _strOpt(a.amount) ?? '?',
    token: 'W0G→0G',
    reason: 'unwrap W0G to native',
  }),
  'stake.stake': a => ({
    kind: 'chain.stake',
    amount: _strOpt(a.amount) ?? '',
    token: '0G→stOG',
    reason: 'Gimo stake',
  }),
  'stake.unstake': a => ({
    kind: 'chain.stake',
    amount: _strOpt(a.amountStog) ?? '',
    token: 'stOG→0G (queued)',
    reason: 'Gimo unstake',
  }),
  'stake.claim': () => ({
    kind: 'chain.stake',
    token: 'claim queued 0G',
    reason: 'Gimo claim',
  }),
  'chain.write': a => ({
    kind: 'chain.write',
    recipient: _strOpt(a.to) ?? '?',
    command: _strOpt(a.signature) ?? '?',
    amount: _strOpt(a.value) ? `${_strOpt(a.value)} wei` : undefined,
    reason: 'arbitrary state-changing call',
  }),
}

function describePermissionCheck(call: { name: string; args: unknown }): PermissionRequest | null {
  const fn = PERMISSION_DESCRIBERS[call.name]
  return fn ? fn((call.args ?? {}) as PermArgs) : null
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
  return `from ${m.fromLabel ?? shortAddr(m.from)} · "${trimmed}"`
}

function formatA2AChannel(m: DeliveredMessage): string {
  const env = m.envelope
  // Prefer the .anima.0g name (or contact label) over the raw address so the
  // brain can use it directly with `agent.message`. Address only as fallback
  // for unknown senders.
  const fromDisplay = m.fromLabel ?? m.from
  const head = `<channel source="anima.inbox" from="${fromDisplay}" address="${m.from}" txHash="${m.txHash}">`
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
