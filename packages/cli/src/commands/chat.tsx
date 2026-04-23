import { mkdir } from 'node:fs/promises'
import { isCancel, password, select, spinner } from '@clack/prompts'
import {
  ActivityLog,
  type AnimaConfig,
  type BrainMessage,
  NETWORK_RPC,
  OGComputeBrain,
  ToolRegistry,
  agentPaths,
  buildFrozenPrefix,
  loadKeystore,
  makeMemorySaveTool,
  newEventId,
  readIndexFile,
} from '@s0nderlabs/anima-core'
import { formatEther } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { pickDefaultAgent } from './_agents'

export async function runChat(opts?: { cwd?: string }): Promise<void> {
  const cwd = opts?.cwd ?? process.cwd()
  const found = await findAndLoadConfig(cwd)
  if (!found) {
    console.log('No anima.config.ts found. Run `anima init` first.')
    process.exit(1)
  }
  let { config } = found
  const configPath = found.path

  const agentId = await pickDefaultAgent()
  if (!agentId) {
    console.log('No agent keystore found in ~/.anima/agents. Run `anima init`.')
    process.exit(1)
  }
  const paths = agentPaths.agent(agentId)

  const pass = await password({ message: `Unlock keystore for agent ${agentId}` })
  if (isCancel(pass) || typeof pass !== 'string') process.exit(1)
  const keystore = await loadKeystore(paths.keystore, pass)

  if (!config.brain.provider) {
    const updated = await runModelPicker(config, keystore, configPath)
    if (!updated) process.exit(1)
    config = updated
  }

  const tools = new ToolRegistry(config.tools)
  tools.register(makeMemorySaveTool({ agentId }) as Parameters<typeof tools.register>[0])

  await mkdir(paths.memoryDir, { recursive: true })
  let memoryIndex = null
  try {
    memoryIndex = await readIndexFile(paths.memoryIndex)
  } catch {
    memoryIndex = null
  }
  const prefix = buildFrozenPrefix({ memoryIndex })
  const activity = new ActivityLog(paths.activityLog)

  const brain = new OGComputeBrain({
    privkeyHex: keystore.privkeyHex,
    rpcUrl: NETWORK_RPC[config.network],
    providerAddress: config.brain.provider!,
    tools: tools.schemas(),
    prefix,
    onToolCall: async call => {
      const result = await tools.dispatch(call)
      await activity.append({
        ts: Date.now(),
        kind: 'tool-call',
        data: { call, result },
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

  const { render } = await import('@opentui/solid')
  const { createCliRenderer } = await import('@opentui/core')
  const { createChatState } = await import('../ui/state')
  const { ChatApp } = await import('../ui/app')

  const renderer = await createCliRenderer({ exitOnCtrlC: false })

  const state = createChatState({
    initialSystem: 'connected. type messages and press enter.',
    identityLabel: `agent ${agentId}  ${shortAddr(keystore.address)}`,
    brainLabel: shortAddr(config.brain.provider!),
  })

  const handleSubmit = async (text: string): Promise<void> => {
    try {
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
    } catch (e) {
      state.pushRow({ role: 'system', text: `error: ${(e as Error).message.slice(0, 300)}` })
      state.setStatus('error')
    }
  }

  const handleExit = (): void => {
    try {
      renderer.destroy()
    } catch {}
    process.exit(0)
  }

  await render(
    () => <ChatApp state={state} onSubmit={handleSubmit} onExit={handleExit} />,
    renderer,
  )
}

async function runModelPicker(
  config: AnimaConfig,
  keystore: Awaited<ReturnType<typeof loadKeystore>>,
  configPath: string,
): Promise<AnimaConfig | null> {
  const s = spinner()
  s.start('Fetching live 0G Compute catalog')
  let services: Awaited<ReturnType<typeof OGComputeBrain.listServicesFor>> = []
  try {
    services = await OGComputeBrain.listServicesFor({
      privkeyHex: keystore.privkeyHex,
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

// Note: chat's ChatApp requires onSubmit to return void or Promise<void>;
// the App type already allows Promise<void>.
