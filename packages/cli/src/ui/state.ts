import type { PermissionDecision, PermissionMode, PermissionRequest } from '@s0nderlabs/anima-core'
import { type JobEvent, isJobTerminalKind } from '@s0nderlabs/anima-plugin-comms'
import { createSignal } from 'solid-js'

export type TurnRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'tool-call'
  | 'tool-result'
  | 'inbox'
  | 'market'
  | 'inbox-tg'
  | 'telegram-assistant'

export interface TurnRow {
  id: string
  role: TurnRole
  text: string
  // tool-call rows: tool name + formatted args (rendered as `name(args)`)
  toolName?: string
  args?: string
  // tool-result rows: failure flag drives icon + color
  failed?: boolean
  // True only for the first row in an "anima block" (assistant + tool-call rows
  // that share the same speaker turn). Computed once at push time so the For
  // loop renderer doesn't re-walk neighbors on every state mutation.
  firstOfBlock?: boolean
}

export interface PendingApproval {
  request: PermissionRequest
  resolve: (decision: PermissionDecision) => void
}

interface CreateChatStateOpts {
  initialSystem: string
  identityLabel: string
  brainLabel: string
  approvalsMode: PermissionMode
}

export function createChatState(opts: CreateChatStateOpts) {
  const [rows, setRows] = createSignal<TurnRow[]>([
    { id: 'sys-0', role: 'system', text: opts.initialSystem },
  ])
  const [input, setInput] = createSignal('')
  const [status, setStatus] = createSignal<'idle' | 'thinking' | 'error'>('idle')
  const [usage, setUsage] = createSignal<{ total?: number; cached?: number } | null>(null)
  const [pendingApproval, setPendingApproval] = createSignal<PendingApproval | null>(null)
  const [approvalsMode, setApprovalsMode] = createSignal<PermissionMode>(opts.approvalsMode)

  // 0G Compute ledger balance, in 0G. Refreshed at chat init and after each
  // per-turn auto-sync. null = not yet fetched / fetch failed.
  const [balance, setBalance] = createSignal<number | null>(null)
  // Agent EOA balance, in 0G. Pays gas for chain writes (agent.message
  // inbox.send, sync's updateSlots anchor). Typically starves before the
  // compute ledger in long sessions (~0.001 0G/send at 4 gwei).
  const [eoaBalance, setEoaBalance] = createSignal<number | null>(null)
  // ms epoch when current turn started (status flipped to 'thinking'). The
  // spinner row reads this and renders elapsed seconds. Cleared on idle.
  const [turnStartedAt, setTurnStartedAt] = createSignal<number | null>(null)

  // Phase 8: in-flight escrow jobs the agent is a party to (buyer or
  // provider). Incremented on JobCreated, decremented once per terminal
  // event per jobId. The contract emits both JobForceClosed AND JobSettled
  // when force-closing a Done job (force-close routes through _settle), so
  // we de-dup by jobId here to keep the counter honest.
  const [activeJobCount, setActiveJobCount] = createSignal(0)
  const terminatedJobs = new Set<string>()
  const bumpActiveJobs = (e: JobEvent) => {
    if (e.kind === 'created') {
      setActiveJobCount(c => c + 1)
      return
    }
    if (!isJobTerminalKind(e.kind)) return
    const id = e.jobId.toString()
    if (terminatedJobs.has(id)) return
    terminatedJobs.add(id)
    setActiveJobCount(c => Math.max(0, c - 1))
  }

  // Per-turn AbortController. Set when handleSubmit kicks off brain.infer;
  // cleared (set to null) after the turn ends or is aborted. The keyboard
  // handler reads it to wire Esc → abort.
  const [activeAbort, setActiveAbort] = createSignal<AbortController | null>(null)

  // Status-change subscribers. Phase 12 telegram-dispatch hooks here so it
  // can drain its queue when the brain returns to idle from a stdin turn.
  type StatusListener = (next: 'idle' | 'thinking' | 'error') => void
  const statusListeners = new Set<StatusListener>()
  const onStatusChange = (cb: StatusListener): (() => void) => {
    statusListeners.add(cb)
    return () => statusListeners.delete(cb)
  }

  // Wrap status setter so the turn-start timestamp tracks status changes
  // automatically. Every code path that flips to 'thinking' starts the
  // clock; every flip to idle/error stops it. Removes the burden from
  // call sites.
  const setStatusTracked: typeof setStatus = next => {
    const prev = status()
    const result = setStatus(next)
    const after = status()
    if (prev !== 'thinking' && after === 'thinking') setTurnStartedAt(Date.now())
    else if (prev === 'thinking' && after !== 'thinking') setTurnStartedAt(null)
    if (prev !== after) {
      for (const cb of statusListeners) {
        try {
          cb(after)
        } catch {
          // listener errors must not break status updates
        }
      }
    }
    return result
  }

  let idCounter = 1
  const nextId = () => `row-${idCounter++}`

  const pushRow = (row: Omit<TurnRow, 'id' | 'firstOfBlock'>) => {
    setRows(prev => {
      const last = prev[prev.length - 1] ?? null
      const isAssistantBlock = row.role === 'assistant' || row.role === 'tool-call'
      const continuesBlock =
        last?.role === 'assistant' || last?.role === 'tool-call' || last?.role === 'tool-result'
      const firstOfBlock = isAssistantBlock && !continuesBlock
      return [...prev, { ...row, id: nextId(), firstOfBlock }]
    })
  }

  return {
    rows,
    input,
    status,
    usage,
    pendingApproval,
    approvalsMode,
    balance,
    eoaBalance,
    turnStartedAt,
    activeAbort,
    activeJobCount,
    setInput,
    setStatus: setStatusTracked,
    setUsage,
    setPendingApproval,
    setApprovalsMode,
    setBalance,
    setEoaBalance,
    setTurnStartedAt,
    setActiveAbort,
    bumpActiveJobs,
    pushRow,
    onStatusChange,
    identityLabel: opts.identityLabel,
    brainLabel: opts.brainLabel,
  }
}

export type ChatState = ReturnType<typeof createChatState>
