/**
 * Lazy multi-provider broker pool. Future-proof for whisper-large-v3 (STT)
 * and z-image (T2I) when those serviceTypes need OpenAI-compat chat
 * completions; today only `chatbot` providers (qwen3-vl-30b for vision)
 * use this path.
 */

import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker'
import { JsonRpcProvider, Wallet } from 'ethers'

type Broker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>

export interface BrokerPoolOpts {
  privkeyHex: `0x${string}`
  rpcUrl: string
}

export interface ProviderHandle {
  endpoint: string
  model: string
  broker: Broker
  providerAddress: string
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: string; [k: string]: unknown }>
}

export interface ChatCompletionRequest {
  messages: ChatCompletionMessage[]
  maxOutputTokens?: number
}

export interface ChatCompletionResult {
  content: string | null
  finishReason?: string
  /** Provider's reported model id; populated once the handle is resolved. */
  model?: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cachedTokens?: number
  }
}

export interface VisionInferImage {
  /** Lowercased mime type, e.g. `image/png`. */
  mediaType: string
  /** Raw image bytes; pool base64-encodes for the data URL. */
  bytes: Uint8Array
}

export interface VisionInferInput {
  images: VisionInferImage[]
  prompt: string
  maxOutputTokens?: number
}

export type VisionInferFn = (input: VisionInferInput) => Promise<ChatCompletionResult>

export class BrokerPool {
  private readonly wallet: Wallet
  private brokerPromise: Promise<Broker> | null = null
  private readonly handles = new Map<string, Promise<ProviderHandle>>()

  constructor(opts: BrokerPoolOpts) {
    const provider = new JsonRpcProvider(opts.rpcUrl)
    this.wallet = new Wallet(opts.privkeyHex, provider)
  }

  private async broker(): Promise<Broker> {
    if (!this.brokerPromise) {
      this.brokerPromise = (async () => {
        // biome-ignore lint/suspicious/noExplicitAny: broker signer shape mismatch is upstream
        return createZGComputeNetworkBroker(this.wallet as any)
      })()
    }
    return this.brokerPromise
  }

  async handle(providerAddress: string): Promise<ProviderHandle> {
    const key = providerAddress.toLowerCase()
    let promise = this.handles.get(key)
    if (!promise) {
      promise = (async () => {
        const broker = await this.broker()
        const meta = await broker.inference.getServiceMetadata(providerAddress)
        try {
          await broker.inference.acknowledgeProviderSigner(providerAddress)
        } catch {
          // Already acknowledged; broker throws on repeat. Safe to ignore.
        }
        return { endpoint: meta.endpoint, model: meta.model, broker, providerAddress }
      })()
      this.handles.set(key, promise)
    }
    return promise
  }

  async chatCompletion(
    providerAddress: string,
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResult> {
    const h = await this.handle(providerAddress)
    const last = req.messages.at(-1)
    if (!last) throw new Error('chatCompletion requires at least one message')
    const lastSerialized =
      typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    const headers = await h.broker.inference.getRequestHeaders(providerAddress, lastSerialized)
    const body: Record<string, unknown> = {
      model: h.model,
      messages: req.messages,
      max_tokens: req.maxOutputTokens ?? 1024,
    }
    const resp = await fetch(`${h.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`compute HTTP ${resp.status}: ${text.slice(0, 200)}`)
    }
    const json = (await resp.json()) as {
      choices: Array<{
        finish_reason?: string
        message: { content?: string | null }
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    const choice = json.choices[0]
    return {
      content: choice?.message.content ?? null,
      finishReason: choice?.finish_reason,
      model: h.model,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
        cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens,
      },
    }
  }

  /**
   * Bind a chat-completions call as a vision inference function: takes raw
   * image bytes, base64-encodes into a data URL with the right media type,
   * and dispatches as an `image_url` content block (OpenAI vision shape).
   */
  visionInferFor(providerAddress: string): VisionInferFn {
    return async input => {
      const userContent: Array<{ type: string; [k: string]: unknown }> = [
        { type: 'text', text: input.prompt },
      ]
      for (const img of input.images) {
        const b64 = Buffer.from(img.bytes).toString('base64')
        userContent.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${b64}` },
        })
      }
      return await this.chatCompletion(providerAddress, {
        messages: [{ role: 'user', content: userContent }],
        maxOutputTokens: input.maxOutputTokens ?? 1024,
      })
    }
  }
}

/**
 * Default mainnet vision provider (qwen3-vl-30b-a3b-instruct on
 * compute-network-3). Hardcoded because: (1) it's currently the ONLY
 * vision-capable model on 0G Compute mainnet; (2) testnet has no vision
 * model. When 0G adds more, switch to a config-picker UI. Until then,
 * `config.vision.provider` overrides this fallback.
 */
export const VISION_PROVIDER_DEFAULTS: Record<'0g-mainnet' | '0g-testnet', string | null> = {
  '0g-mainnet': '0x4415ef5CBb415347bb18493af7cE01f225Fc0868',
  '0g-testnet': null,
}
