/**
 * 0G Compute-backed brain. Upstream `@0glabs/0g-serving-broker` requires an
 * ethers Wallet/Signer — this file is the ONLY place in anima where ethers
 * is imported. Callers pass a raw privkey hex + RPC URL; the module builds
 * the ethers Wallet internally so the rest of the codebase can remain
 * viem-first.
 */
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker'
import { JsonRpcProvider, Wallet } from 'ethers'
import type { ToolSchema } from '../tools/types'
import { type FrozenPrefix, renderFrozenPrefix } from './frozen-prefix'
import type { Brain, BrainInferInput, BrainMessage, BrainTurn } from './types'

type Broker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>

export interface OGComputeBrainOpts {
  privkeyHex: `0x${string}`
  rpcUrl: string
  providerAddress: string
  tools: ToolSchema[]
  prefix: FrozenPrefix
  history?: BrainMessage[]
  maxOutputTokens?: number
  onToolCall?: (call: { id: string; name: string; args: unknown }) => Promise<BrainMessage>
}

export interface ListedService {
  provider: string
  url?: string
  endpoint?: string
  model: string
  serviceType?: string
  inputPrice?: bigint
  outputPrice?: bigint
  verifiability?: string
  [k: string]: unknown
}

export class OGComputeBrain implements Brain {
  private broker: Broker | null = null
  private endpoint: string | null = null
  private model: string | null = null
  private readonly history: BrainMessage[]
  private readonly wallet: Wallet
  private readonly renderedPrefix: string

  constructor(private readonly opts: OGComputeBrainOpts) {
    this.history = opts.history ? [...opts.history] : []
    const provider = new JsonRpcProvider(opts.rpcUrl)
    this.wallet = new Wallet(opts.privkeyHex, provider)
    this.renderedPrefix = renderFrozenPrefix(opts.prefix)
  }

  async init(): Promise<void> {
    if (this.broker) return
    // biome-ignore lint/suspicious/noExplicitAny: broker signer shape mismatch is upstream
    this.broker = await createZGComputeNetworkBroker(this.wallet as any)
    const meta = await this.broker.inference.getServiceMetadata(this.opts.providerAddress)
    this.endpoint = meta.endpoint
    this.model = meta.model
    try {
      await this.broker.inference.acknowledgeProviderSigner(this.opts.providerAddress)
    } catch {
      // Already acknowledged — broker throws on repeat. Safe to ignore.
    }
  }

  /** Fetch live catalog without requiring a specific provider to be pre-set. */
  static async listServicesFor(args: {
    privkeyHex: `0x${string}`
    rpcUrl: string
  }): Promise<ListedService[]> {
    const provider = new JsonRpcProvider(args.rpcUrl)
    const wallet = new Wallet(args.privkeyHex, provider)
    // biome-ignore lint/suspicious/noExplicitAny: broker signer shape mismatch is upstream
    const broker = await createZGComputeNetworkBroker(wallet as any)
    return (await broker.inference.listService()) as unknown as ListedService[]
  }

  async listServices(): Promise<ListedService[]> {
    if (!this.broker) await this.init()
    const services = (await this.broker!.inference.listService()) as unknown as ListedService[]
    return services
  }

  async infer(input: BrainInferInput): Promise<BrainTurn> {
    if (!this.broker) await this.init()
    const userText = normalizeUserContent(input)
    const messages: BrainMessage[] = [
      { role: 'system', content: this.renderedPrefix },
      ...this.history,
      { role: 'user', content: userText },
    ]

    let turnResult: BrainTurn | null = null
    const MAX_ROUND_TRIPS = 5
    for (let i = 0; i < MAX_ROUND_TRIPS; i++) {
      const resp = await this.callCompletion(messages)
      turnResult = resp

      if (!resp.toolCalls.length) {
        messages.push({ role: 'assistant', content: resp.content ?? '' })
        break
      }

      messages.push({
        role: 'assistant',
        content: resp.content ?? '',
      })

      for (const call of resp.toolCalls) {
        if (!this.opts.onToolCall) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ error: 'Tool handler not wired' }),
          })
          continue
        }
        const toolMsg = await this.opts.onToolCall(call)
        messages.push({ ...toolMsg, toolCallId: call.id })
      }
    }

    const finalAssistant = findLastAssistantContent(messages)
    this.history.push({ role: 'user', content: userText })
    this.history.push({ role: 'assistant', content: finalAssistant })

    return turnResult ?? { content: null, toolCalls: [] }
  }

  private async callCompletion(messages: BrainMessage[]): Promise<BrainTurn> {
    if (!this.broker || !this.endpoint || !this.model) {
      throw new Error('Brain not initialized; call init() first.')
    }
    const last = messages.at(-1)!
    const headers = await this.broker.inference.getRequestHeaders(
      this.opts.providerAddress,
      typeof last.content === 'string' ? last.content : JSON.stringify(last.content),
    )
    const body = {
      model: this.model,
      messages: messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
        }
        return { role: m.role, content: m.content }
      }),
      tools: this.opts.tools,
      tool_choice: 'auto' as const,
      max_tokens: this.opts.maxOutputTokens ?? 1024,
    }
    const resp = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      throw new Error(`Brain HTTP ${resp.status}: ${await resp.text()}`)
    }
    const json = (await resp.json()) as {
      choices: Array<{
        finish_reason?: string
        message: {
          content?: string | null
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
          }>
          reasoning_content?: string
        }
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    const choice = json.choices[0]!
    const msg = choice.message
    return {
      content: msg.content ?? null,
      toolCalls: (msg.tool_calls ?? []).map(tc => ({
        id: tc.id,
        name: tc.function.name,
        args: safeParseJson(tc.function.arguments),
      })),
      reasoningContent: msg.reasoning_content,
      finishReason: choice.finish_reason,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
        cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens,
      },
    }
  }
}

function normalizeUserContent(input: BrainInferInput): string {
  const d = input.event.payload.data
  if (typeof d === 'string') return d
  return JSON.stringify(d)
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function findLastAssistantContent(messages: BrainMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'assistant') return m.content
  }
  return ''
}
