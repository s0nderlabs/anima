import type { PermissionDecision, PermissionMode, PermissionRequest } from '@s0nderlabs/anima-core'
import { createSignal } from 'solid-js'

export interface TurnRow {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
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

  let idCounter = 1
  const nextId = () => `row-${idCounter++}`

  const pushRow = (row: Omit<TurnRow, 'id'>) => {
    setRows(prev => [...prev, { ...row, id: nextId() }])
  }

  return {
    rows,
    input,
    status,
    usage,
    pendingApproval,
    approvalsMode,
    setInput,
    setStatus,
    setUsage,
    setPendingApproval,
    setApprovalsMode,
    pushRow,
    identityLabel: opts.identityLabel,
    brainLabel: opts.brainLabel,
  }
}

export type ChatState = ReturnType<typeof createChatState>
