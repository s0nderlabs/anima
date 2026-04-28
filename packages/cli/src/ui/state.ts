import type { PermissionDecision, PermissionMode, PermissionRequest } from '@s0nderlabs/anima-core'
import { createSignal } from 'solid-js'

export type TurnRole = 'user' | 'assistant' | 'system' | 'tool-call' | 'tool-result'

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

  // Per-turn AbortController. Set when handleSubmit kicks off brain.infer;
  // cleared (set to null) after the turn ends or is aborted. The keyboard
  // handler reads it to wire Esc → abort.
  const [activeAbort, setActiveAbort] = createSignal<AbortController | null>(null)

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
    activeAbort,
    setInput,
    setStatus,
    setUsage,
    setPendingApproval,
    setApprovalsMode,
    setActiveAbort,
    pushRow,
    identityLabel: opts.identityLabel,
    brainLabel: opts.brainLabel,
  }
}

export type ChatState = ReturnType<typeof createChatState>
