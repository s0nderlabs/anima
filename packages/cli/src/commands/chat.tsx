import { mkdir } from 'node:fs/promises'
import { isCancel, select, spinner } from '@clack/prompts'
import {
  ActivityLog,
  type AnimaConfig,
  type BrainMessage,
  MemorySyncManager,
  NETWORK_RPC,
  OGComputeBrain,
  ToolRegistry,
  agentPaths,
  buildFrozenPrefix,
  explorerTxUrl,
  fetchAndDecryptKeystore,
  iNFTAgentId,
  makeMemoryReadTool,
  makeMemorySaveTool,
  newEventId,
  readIndexFile,
} from '@s0nderlabs/anima-core'
import { type Address, type Hex, formatEther } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export async function runChat(opts?: { cwd?: string }): Promise<void> {
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

  const sync = new MemorySyncManager({
    network: config.network,
    agentId,
    agentPrivkey,
    agentAddress,
    contractAddress,
    tokenId,
  })
  // We deliberately skip `sync.init()` — it would seed lastPlaintextHash with
  // on-chain CIPHERTEXT hashes which never equal local plaintext hashes, so
  // the first flush would re-upload everything anyway. Letting plaintextHash
  // start empty produces the same one-time re-anchor on first flush, then
  // steady-state diffing kicks in without a wasted RPC call.

  await mkdir(paths.memoryDir, { recursive: true })
  let memoryIndex = null
  try {
    memoryIndex = await readIndexFile(paths.memoryIndex)
  } catch {
    memoryIndex = null
  }
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

  // Render TUI state has to exist before brain construction so the onToolCall
  // closure can reference it without a forward reference. Tool indicators
  // need state.pushRow as soon as a tool fires (claude-code / hermes pattern).
  const { render } = await import('@opentui/solid')
  const { createCliRenderer } = await import('@opentui/core')
  const { createChatState } = await import('../ui/state')
  const { ChatApp } = await import('../ui/app')

  const renderer = await createCliRenderer({ exitOnCtrlC: false })

  const state = createChatState({
    initialSystem: 'connected. type messages and press enter.',
    identityLabel: `agent ${agentId}  ${shortAddr(agentAddress)}`,
    brainLabel: shortAddr(config.brain.provider!),
  })

  const brain = new OGComputeBrain({
    privkeyHex: agentPrivkey,
    rpcUrl: NETWORK_RPC[config.network],
    providerAddress: config.brain.provider!,
    tools: tools.schemas(),
    prefix,
    onToolCall: async call => {
      state.pushRow({ role: 'system', text: renderToolCallBadge(call) })
      const result = await tools.dispatch(call)
      await activity.append({
        ts: Date.now(),
        kind: 'tool-call',
        data: { call, result },
      })
      state.pushRow({
        role: 'system',
        text: renderToolResultBadge(call.name, result),
      })
      return {
        role: 'tool',
        content: JSON.stringify(result),
      } as BrainMessage
    },
  })
  const bootSpinner = spinner()
  bootSpinner.start(`Connecting to 0G Compute (${shortAddr(config.brain.provider!)})`)
  try {
    await brain.init()
    bootSpinner.stop('Connected')
  } catch (e) {
    bootSpinner.stop(`Connection failed: ${(e as Error).message.slice(0, 120)}`)
    process.exit(1)
  }

  const handleSubmit = async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed.startsWith('/')) {
      const handled = await handleSlash(trimmed)
      if (handled) return
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
      // anchor in iNFT. Fire-and-forget — chat doesn't wait. Errors surface as
      // an inline system row so the operator notices but the conversation flows.
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
            text: `sync error: ${(e as Error).message.slice(0, 200)}`,
          })
        })
    } catch (e) {
      state.pushRow({ role: 'system', text: `error: ${(e as Error).message.slice(0, 300)}` })
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
        state.pushRow({ role: 'system', text: `sync error: ${(e as Error).message.slice(0, 200)}` })
      }
      return true
    }
    if (cmd === '/help') {
      state.pushRow({
        role: 'system',
        text: 'slash commands:\n  /sync — force memory + activity flush to 0G\n  /model — switch brain (run anima model after exiting)\n  /help — this message',
      })
      return true
    }
    return false
  }

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

function renderToolCallBadge(call: { name: string; args: unknown }): string {
  const args = summarizeArgs(call.args)
  return `▸ ${call.name}(${args})`
}

function renderToolResultBadge(name: string, result: unknown): string {
  const r = result as { ok?: boolean; error?: string; data?: { path?: string } } | null | undefined
  if (r && r.ok === true) {
    if (
      r.data &&
      typeof r.data === 'object' &&
      'path' in r.data &&
      typeof r.data.path === 'string'
    ) {
      return `  ↳ ${name} ok · ${r.data.path}`
    }
    return `  ↳ ${name} ok`
  }
  if (r && r.ok === false) {
    return `  ↳ ${name} failed · ${(r.error ?? '').slice(0, 120)}`
  }
  return `  ↳ ${name} done`
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
