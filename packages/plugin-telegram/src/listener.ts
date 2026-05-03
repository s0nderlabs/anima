import { Bot, type Context, GrammyError, HttpError } from 'grammy'
import { DebounceBuffer, type FlushedBatch } from './debounce'
import { formatTelegramChannel } from './format'
import { RateLimiter } from './limits'
import { formatPairingMessage } from './pairing-flow'
import { reactError, reactProcessing, reactSuccess } from './reactions'
import {
  BotTokenLockedError,
  type TokenLock,
  acquireTelegramTokenLock,
  classifyStartFailure,
  clearWebhookBeforePolling,
} from './recovery'
import { sendWithRetry } from './retry'
import { sanitizeInbound } from './sanitize'
import { buildSessionKey } from './session-key'
import type { TelegramDispatchInput, TelegramRuntimeContext } from './types'

/**
 * Long-poll Telegram bot. Inbound DMs from allowedUserIds are debounced and
 * dispatched to the brain via `dispatchUserMessage`. Reactions transition
 * from 👀 (processing) → 👍/👎 (success/error). Reply text is sent back via
 * grammy's `bot.api.sendMessage` with retry-classified backoff.
 *
 * Lifecycle: `start()` acquires a host-wide token lock, clears any stale
 * webhook, then boots grammy in long-poll mode. `stop()` releases the lock
 * and stops the bot. Both are idempotent.
 */
export interface TelegramListenerOpts extends TelegramRuntimeContext {
  /** Optional override of the Telegram Bot API root. Used by the mock-bot test. */
  apiRoot?: string
  /** Optional per-user rate-limit. Default capacity=30, window=60s. */
  rateLimit?: { capacity: number; windowMs: number }
  /** Optional debounce window. Default 600ms. */
  debounceMs?: number
  /** Optional override of the locks dir (test only). */
  lockRootDir?: string
}

export class TelegramListener {
  private readonly opts: TelegramListenerOpts
  private readonly bot: Bot
  private readonly limiter: RateLimiter
  private readonly debounce: DebounceBuffer
  private readonly inflight = new Map<number, Promise<void>>()
  private running = false
  private tokenLock: TokenLock | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: TelegramListenerOpts) {
    this.opts = opts
    this.bot = new Bot(opts.botToken, opts.apiRoot ? { client: { apiRoot: opts.apiRoot } } : {})
    this.limiter = new RateLimiter(opts.rateLimit)
    this.debounce = new DebounceBuffer((chatId, batch) => this.handleFlushed(chatId, batch), {
      quietPeriodMs: opts.debounceMs,
    })
    this.bot.on('message', ctx => this.onMessage(ctx))
    this.bot.catch(err => {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`grammy.catch: ${msg.slice(0, 200)}`)
    })
  }

  async start(): Promise<void> {
    if (this.running) return

    try {
      this.tokenLock = acquireTelegramTokenLock(this.opts.botToken, {
        agentId: this.opts.agentName,
        rootDir: this.opts.lockRootDir,
      })
    } catch (err) {
      if (err instanceof BotTokenLockedError) {
        console.warn(`[telegram] cannot start listener: ${err.message}`)
      }
      throw err
    }

    this.running = true
    console.log(`[telegram] listener.start() called for @${this.opts.agentName}`)

    if (this.opts.allowedUserIds.length === 0 && !this.opts.pairingStore) {
      console.warn(
        '[telegram] no allowlist configured AND no pairing store. ' +
          'All inbound messages will be DROPPED. Configure allowedUserIds via ' +
          '`anima telegram setup` or enable pairing.',
      )
    }

    await clearWebhookBeforePolling(this.bot)

    this.refreshTimer = setInterval(() => {
      if (this.tokenLock && !this.tokenLock.refresh()) {
        console.warn('[telegram] token lock lost - stopping listener')
        void this.stop()
      }
    }, 60_000)

    void this.bot
      .start({
        onStart: info => console.log(`[telegram] listener active @${info.username}`),
        drop_pending_updates: true,
        allowed_updates: ['message'],
      })
      .catch(err => {
        const verdict = classifyStartFailure(err)
        console.error(`[telegram] bot.start ${verdict.kind}: ${verdict.detail.slice(0, 400)}`)
        this.running = false
        this.releaseLock()
      })
  }

  async stop(): Promise<void> {
    if (!this.running) {
      this.releaseLock()
      return
    }
    this.running = false
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    this.debounce.flushAll()
    try {
      await this.bot.stop()
    } catch {
      // grammy stop can throw if start hasn't completed; ignore.
    }
    await Promise.allSettled([...this.inflight.values()])
    this.releaseLock()
  }

  private releaseLock(): void {
    if (this.tokenLock) {
      try {
        this.tokenLock.release()
      } catch {
        /* best-effort */
      }
      this.tokenLock = null
    }
  }

  /**
   * Handle one inbound TG update. Sanitize → rate-limit → debounce.
   * Errors here are swallowed (logged) so grammy stays alive.
   */
  private async onMessage(ctx: Context): Promise<void> {
    const msg = ctx.message
    if (!msg) return
    const sanitized = sanitizeInbound(
      {
        chatType: msg.chat.type,
        chatId: msg.chat.id,
        fromId: msg.from?.id ?? null,
        fromIsBot: msg.from?.is_bot ?? false,
        fromUsername: msg.from?.username ?? null,
        fromFirstName: msg.from?.first_name ?? null,
        fromLastName: msg.from?.last_name ?? null,
        text: msg.text ?? msg.caption ?? null,
        messageId: msg.message_id,
        forwardedFrom:
          (msg as { forward_from?: unknown; forward_origin?: unknown }).forward_from ??
          (msg as { forward_origin?: unknown }).forward_origin ??
          null,
        mediaGroupId: msg.media_group_id ?? null,
      },
      {
        allowedUserIds: this.opts.allowedUserIds,
        pairingStore: this.opts.pairingStore,
      },
    )
    if (!sanitized.ok) {
      if (sanitized.action === 'send-pairing-code' && sanitized.code) {
        const text = formatPairingMessage({
          code: sanitized.code,
          agentName: this.opts.agentName,
        })
        try {
          await this.bot.api.sendMessage(msg.chat.id, text)
        } catch (sendErr) {
          this.log(`pairing-code send failed: ${(sendErr as Error).message?.slice(0, 200) ?? ''}`)
        }
      }
      this.log(`drop: ${sanitized.reason} from chat=${msg.chat.id}`)
      return
    }
    const event = sanitized.event
    if (this.limiter.shouldDrop(event.userId)) {
      this.log(`rate-limit-drop user=${event.userId}`)
      void reactError(this.bot, event.chatId, event.messageId)
      return
    }
    this.debounce.push(event.chatId, {
      text: event.text,
      messageId: event.messageId,
      ts: event.ts,
      userId: event.userId,
      username: event.username,
      displayName: event.displayName,
    })
  }

  private handleFlushed(chatId: number, batch: FlushedBatch): void {
    const existing = this.inflight.get(chatId)
    const next = (existing ?? Promise.resolve()).then(() => this.dispatchOne(chatId, batch))
    this.inflight.set(
      chatId,
      next.finally(() => {
        if (this.inflight.get(chatId) === next) this.inflight.delete(chatId)
      }),
    )
  }

  private async dispatchOne(chatId: number, batch: FlushedBatch): Promise<void> {
    const messageId = batch.latestMessageId
    void reactProcessing(this.bot, chatId, messageId)
    if (this.opts.onProcessingStart) {
      try {
        await this.opts.onProcessingStart(chatId, messageId)
      } catch {
        /* never block on hook failures */
      }
    }
    let ok = true
    try {
      const input: TelegramDispatchInput = {
        text: batch.text,
        chatId,
        userId: batch.userId,
        username: batch.username,
        displayName: batch.displayName,
        latestMessageId: messageId,
        sessionKey: buildSessionKey({ agentName: this.opts.agentName, chatId }),
      }
      const channelText = formatTelegramChannel({
        chatId,
        username: batch.username,
        displayName: batch.displayName,
        text: batch.text,
      })
      const result = await this.opts.dispatchUserMessage({ ...input, text: channelText })
      const reply = result.response.trim()
      if (reply.length > 0) {
        await sendWithRetry(() =>
          this.bot.api.sendMessage(chatId, capForTelegram(reply), {
            reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
          }),
        )
      }
      void reactSuccess(this.bot, chatId, messageId)
    } catch (err) {
      ok = false
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`dispatch failed: ${msg.slice(0, 200)}`)
      void reactError(this.bot, chatId, messageId)
      try {
        await this.bot.api.sendMessage(
          chatId,
          'sorry, something went wrong on my side. try again in a moment.',
          { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } },
        )
      } catch {
        /* swallow */
      }
    }
    if (this.opts.onProcessingEnd) {
      try {
        await this.opts.onProcessingEnd(chatId, messageId, ok)
      } catch {
        /* never block */
      }
    }
  }

  private log(line: string): void {
    if (this.opts.debug) console.log(`[telegram] ${line}`)
  }
}

/** Telegram caps messages at 4096 chars. We cap at 4000 to leave header room. */
export function capForTelegram(text: string): string {
  if (text.length <= 4000) return text
  return `${text.slice(0, 3970)}\n[reply truncated]`
}

export { GrammyError, HttpError }
