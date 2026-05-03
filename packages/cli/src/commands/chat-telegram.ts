/**
 * Local-mode telegram dispatch wiring for chat.tsx.
 *
 * Two pieces:
 *
 *  1. `buildTelegramRuntimeContext`: composes the side-band context the plugin
 *     consumes via `(ctx as any).telegram`. The context's `dispatchUserMessage`
 *     points at a *deferred* callback ref; chat.tsx populates the ref AFTER
 *     brain init but BEFORE any inbound TG message can race.
 *
 *  2. `buildTelegramDispatch`: factory for the deferred callback itself. It
 *     mirrors the `drainInbound` shape from chat.tsx (refresh prefix, wake
 *     activity, brain.infer with source=telegram, log brain-response, push
 *     'telegram-assistant' row to TUI, fire-and-forget memory sync).
 *
 *  Splitting these out keeps chat.tsx read-able and lets us unit-test the pure
 *  pieces.
 */
import type {
  ActivityLog,
  Brain,
  FrozenPrefix,
  MemorySyncManager,
  PermissionService,
} from '@s0nderlabs/anima-core'
import { newEventId } from '@s0nderlabs/anima-core'
import type {
  TelegramDispatchInput,
  TelegramDispatchResult,
  TelegramRuntimeContext,
} from '@s0nderlabs/anima-plugin-telegram'

export type DispatchUserMessage = (input: TelegramDispatchInput) => Promise<TelegramDispatchResult>

/**
 * Mutable callback ref. chat.tsx holds it across boot; we hand the ref into
 * the plugin's runtime context via a closure that defers to the ref's current
 * value at call-time.
 */
export interface TelegramDispatchSlot {
  current: DispatchUserMessage | null
}

export interface RowSinkRef {
  current: ((text: string) => void) | null
}

export function buildTelegramRuntimeContext(opts: {
  botToken: string
  allowedUserIds: number[]
  agentName: string
  slot: TelegramDispatchSlot
  systemRowSink: RowSinkRef
}): TelegramRuntimeContext {
  return {
    botToken: opts.botToken,
    allowedUserIds: opts.allowedUserIds,
    agentName: opts.agentName,
    dispatchUserMessage: async input => {
      const cb = opts.slot.current
      if (!cb) {
        return {
          response: 'agent is still booting; try again in a moment.',
        }
      }
      return cb(input)
    },
    onProcessingStart: async (chatId, _msgId) => {
      opts.systemRowSink.current?.(`tg replying to chat ${chatId}`)
    },
    onProcessingEnd: async (chatId, _msgId, ok) => {
      opts.systemRowSink.current?.(
        ok ? `tg reply sent to chat ${chatId}` : `tg reply FAILED to chat ${chatId}`,
      )
    },
  }
}

export interface BuildDispatchDeps {
  activity: ActivityLog
  sync: MemorySyncManager
  permission: PermissionService
  pushAssistantRow: (text: string) => void
  pushInboundRow: (preview: string) => void
  /** Returns true if the brain is currently busy on another turn. */
  isBusy: () => boolean
  buildPrefix: () => Promise<FrozenPrefix>
  brain: Brain & { refreshUserContext: (prefix: FrozenPrefix) => void }
  /** Mark the brain as "thinking" / idle in the TUI state. */
  setThinking: (on: boolean) => void
  setActiveAbort: (ctrl: AbortController | null) => void
  refreshBalances: () => void
  formatInboundPreview: (input: TelegramDispatchInput) => string
}

/**
 * Build the deferred dispatch callback. Caller assigns the returned function
 * into `slot.current` once brain.init resolves.
 */
export function buildTelegramDispatch(deps: BuildDispatchDeps): DispatchUserMessage {
  const queue: { input: TelegramDispatchInput; resolve: (r: TelegramDispatchResult) => void }[] = []
  let draining = false

  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        if (deps.isBusy()) return // single-flight gate; chat handler will retry on idle
        const item = queue.shift()!
        try {
          const r = await runOne(item.input, deps)
          item.resolve(r)
        } catch (err) {
          item.resolve({
            response: `error processing your message: ${(err as Error).message.slice(0, 200)}`,
          })
        }
      }
    } finally {
      draining = false
    }
  }

  return (input: TelegramDispatchInput) =>
    new Promise<TelegramDispatchResult>(resolve => {
      // Inbound preview row goes up immediately so the operator sees the
      // arrival even if a stdin turn is in flight.
      deps.pushInboundRow(deps.formatInboundPreview(input))
      queue.push({ input, resolve })
      void drain()
    })
}

async function runOne(
  input: TelegramDispatchInput,
  deps: BuildDispatchDeps,
): Promise<TelegramDispatchResult> {
  // Force YOLO for TG turns: the operator cannot reach the laptop modal from
  // their phone. Sandboxed limbs (Phase 9.5) provide structural enforcement;
  // the permission floor is bypassed only for this single turn, then restored.
  const previousMode = deps.permission.getMode()
  deps.permission.setMode('off')
  deps.setThinking(true)
  const abortCtrl = new AbortController()
  deps.setActiveAbort(abortCtrl)
  try {
    const refreshed = await deps.buildPrefix()
    deps.brain.refreshUserContext(refreshed)
    await deps.activity.append({
      ts: Date.now(),
      kind: 'wake',
      data: { source: 'telegram', chatId: input.chatId, userId: input.userId },
    })
    const turn = await deps.brain.infer({
      event: {
        id: newEventId(),
        source: 'telegram',
        payload: { label: 'telegram-message', data: input.text },
        ts: Date.now(),
      },
      signal: abortCtrl.signal,
    })
    await deps.activity.append({
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
    if (response.length > 0) deps.pushAssistantRow(response)
    deps.refreshBalances()
    let syncTx: string | undefined
    try {
      const res = await deps.sync.flushTurn()
      if (res.txHash) syncTx = res.txHash
    } catch {
      // sync errors stay in the activity log; not surfaced to TG.
    }
    return { response: response.length === 0 ? '(no reply)' : response, syncTx }
  } finally {
    deps.setThinking(false)
    deps.setActiveAbort(null)
    deps.permission.setMode(previousMode)
  }
}
