import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { For, Show } from 'solid-js'
import type { ChatState, TurnRow } from './state'

function formatUsage(usage: { total?: number; cached?: number } | null | undefined): string {
  if (!usage) return ''
  const total = usage.total ?? 0
  const cached = usage.cached ?? 0
  return cached ? `  · ${total}t (${cached} cached)` : `  · ${total}t`
}

interface AppProps {
  state: ChatState
  onSubmit: (text: string) => void | Promise<void>
  onExit: () => void
}

const ROLE_COLORS: Record<TurnRow['role'], string> = {
  user: '#67e8f9',
  assistant: '#86efac',
  system: '#9ca3af',
  tool: '#c4b5fd',
}

const ROLE_LABELS: Record<TurnRow['role'], string> = {
  user: 'you ',
  assistant: 'anim',
  system: 'sys ',
  tool: 'tool',
}

function summarizeApproval(req: {
  kind: string
  command?: string
  path?: string
  reason: string
}): string {
  const subject = req.command ?? req.path ?? '(unspecified)'
  return `[approval] ${req.reason}, ${req.kind}: ${subject}`
}

export function ChatApp(props: AppProps) {
  const dims = useTerminalDimensions()

  useKeyboard(evt => {
    if (evt.ctrl && evt.name === 'c') {
      evt.preventDefault()
      props.onExit()
      return
    }
    // Approval modal mode: swallow keys, route y/s/n to decision.
    const pending = props.state.pendingApproval()
    if (pending) {
      if (evt.name === 'return') return
      if (evt.sequence) {
        const ch = evt.sequence.toLowerCase()
        if (ch === 'y' || ch === '1') {
          pending.resolve('allow-once')
          props.state.setPendingApproval(null)
          return
        }
        if (ch === 's' || ch === '2') {
          pending.resolve('allow-session')
          props.state.setPendingApproval(null)
          return
        }
        if (ch === 'n' || ch === 'd' || ch === '3' || evt.name === 'escape') {
          pending.resolve('deny')
          props.state.setPendingApproval(null)
          return
        }
      }
      return
    }
    if (evt.name === 'return') {
      const text = props.state.input().trim()
      if (!text) return
      props.state.pushRow({ role: 'user', text })
      props.state.setInput('')
      props.state.setStatus('thinking')
      props.onSubmit(text)
      return
    }
    if (evt.name === 'backspace' || evt.name === 'delete') {
      props.state.setInput(prev => prev.slice(0, -1))
      return
    }
    if (evt.sequence && !evt.ctrl && !evt.meta && evt.sequence.length === 1) {
      const ch = evt.sequence
      props.state.setInput(prev => prev + ch)
    }
  })

  return (
    <box flexDirection="column" width={dims().width} height={dims().height}>
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        <For each={props.state.rows()}>
          {row => (
            <box flexDirection="row">
              <text fg={ROLE_COLORS[row.role]}>{ROLE_LABELS[row.role]}</text>
              <text> </text>
              <text>{row.text}</text>
            </box>
          )}
        </For>
      </box>

      <Show when={props.state.pendingApproval()}>
        <box
          flexDirection="column"
          borderStyle="rounded"
          borderColor="#f59e0b"
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg="#f59e0b">{summarizeApproval(props.state.pendingApproval()!.request)}</text>
          <text fg="#9ca3af">[y] allow once [s] allow session [n] deny</text>
        </box>
      </Show>

      <box
        flexDirection="row"
        borderStyle="rounded"
        borderColor="#4b5563"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg="#67e8f9">{'> '}</text>
        <text>{props.state.input()}</text>
        <Show when={props.state.status() !== 'idle'}>
          <text fg="#9ca3af"> ({props.state.status()})</text>
        </Show>
      </box>

      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg="#6b7280">
          {props.state.identityLabel} · brain: {props.state.brainLabel} · perms:{' '}
          {props.state.approvalsMode()} · ctrl+c to exit
        </text>
        <Show when={props.state.usage()}>
          <text fg="#6b7280">{formatUsage(props.state.usage())}</text>
        </Show>
      </box>
    </box>
  )
}
