import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { MarkdownSegments } from './markdown'
import type { ChatState, TurnRow } from './state'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const SPINNER_FRAME_MS = 80

// opentui's <span> accepts `fg` at runtime but the SpanProps type omits it,
// and every workaround we tried fails:
//   - dynamic <Tag> wrapper (`const Tag = 'span' as any`): solid's JSX
//     transform resolves Tag and crashes with `Comp is not a function`.
//   - module-level function-typed alias (`const Sp = 'span' as unknown as
//     (p) => JSX.Element`): same crash — runtime value is still a string,
//     solid invokes it as a function in completeUpdates and throws.
//   - module augmentation `interface SpanProps { fg?: string }`: opentui
//     exports SpanProps in a way that doesn't merge.
//   - inline ANSI `\x1b[38;2;…m`: opentui's <text> renders them literally.
// Direct `<span fg=…>` with `@ts-expect-error` is the only path that works.

interface AppProps {
  state: ChatState
  onSubmit: (text: string) => void | Promise<void>
  onExit: () => void
}

const PREFIX_GUTTER = '   '
const LABEL_WIDTH = 5
const BODY_INDENT = `${PREFIX_GUTTER}${' '.repeat(LABEL_WIDTH + 2)}`
const TOOL_RESULT_INDENT = `${BODY_INDENT}  `

function pad5(s: string): string {
  return s.padEnd(LABEL_WIDTH, ' ')
}

function renderPrefix(label: string): string {
  return `${PREFIX_GUTTER}${pad5(label)}  `
}

function formatUsage(usage: { total?: number; cached?: number } | null | undefined): string {
  if (!usage) return ''
  const total = usage.total ?? 0
  const cached = usage.cached ?? 0
  const totalK = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`
  const cachedK = cached >= 1000 ? `${(cached / 1000).toFixed(1)}k` : `${cached}`
  return cached ? `${totalK} t (${cachedK} cached)` : `${totalK} t`
}

function summarizeApprovalSubject(req: {
  kind: string
  command?: string
  path?: string
}): string {
  return req.command ?? req.path ?? '(unspecified)'
}

function UserRow(props: { text: string }) {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg="#67e8f9" flexShrink={0}>
        {renderPrefix('you')}
      </text>
      <text wrapMode="word" flexGrow={1} fg="#e5e7eb">
        {props.text}
      </text>
    </box>
  )
}

function SystemRow(props: { text: string }) {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg="#9ca3af" flexShrink={0}>
        {renderPrefix('sys')}
      </text>
      <text wrapMode="word" flexGrow={1} fg="#9ca3af">
        {props.text}
      </text>
    </box>
  )
}

function AssistantTextRow(props: { text: string; firstOfBlock: boolean }) {
  return (
    <box flexDirection="row" marginTop={props.firstOfBlock ? 0 : 1} marginBottom={1}>
      <text fg="#86efac" flexShrink={0}>
        {props.firstOfBlock ? renderPrefix('anima') : BODY_INDENT}
      </text>
      <text wrapMode="word" flexGrow={1} fg="#e5e7eb">
        <MarkdownSegments text={props.text} />
      </text>
    </box>
  )
}

function ToolCallRow(props: {
  toolName: string
  args: string
  firstOfBlock: boolean
}) {
  return (
    <box flexDirection="row">
      <text fg="#86efac" flexShrink={0}>
        {props.firstOfBlock ? renderPrefix('anima') : BODY_INDENT}
      </text>
      <text wrapMode="word" flexGrow={1}>
        {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
        <span fg="#c4b5fd">{'⏺ '}</span>
        {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
        <span fg="#e5e7eb">{props.toolName}</span>
        <Show when={props.args}>
          {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
          <span fg="#6b7280">{`(${props.args})`}</span>
        </Show>
      </text>
    </box>
  )
}

function ToolResultRow(props: { text: string; failed: boolean }) {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text flexShrink={0}>{TOOL_RESULT_INDENT}</text>
      <text wrapMode="word" flexGrow={1}>
        {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
        <span fg={props.failed ? '#fca5a5' : '#4b5563'}>{props.failed ? '✗ ' : '⎿ '}</span>
        {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
        <span fg={props.failed ? '#fca5a5' : '#9ca3af'}>{props.text}</span>
      </text>
    </box>
  )
}

function ChatRowDispatch(props: { row: TurnRow }) {
  const r = props.row
  if (r.role === 'user') return <UserRow text={r.text} />
  if (r.role === 'system') return <SystemRow text={r.text} />
  if (r.role === 'assistant')
    return <AssistantTextRow text={r.text} firstOfBlock={r.firstOfBlock === true} />
  if (r.role === 'tool-call')
    return (
      <ToolCallRow
        toolName={r.toolName ?? '(unknown)'}
        args={r.args ?? ''}
        firstOfBlock={r.firstOfBlock === true}
      />
    )
  if (r.role === 'tool-result') return <ToolResultRow text={r.text} failed={r.failed === true} />
  return null
}

export function ChatApp(props: AppProps) {
  const dims = useTerminalDimensions()
  const [spinnerFrame, setSpinnerFrame] = createSignal(0)
  // Only tick while we're actually waiting on the brain. Otherwise the signal
  // would notify subscribers 12.5x/sec for nothing — wasteful in the renderer.
  createEffect(() => {
    if (props.state.status() !== 'thinking') {
      setSpinnerFrame(0)
      return
    }
    const id = setInterval(
      () => setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_FRAME_MS,
    )
    onCleanup(() => clearInterval(id))
  })

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
      {/* Chat history — scrollable so it never crowds the input area. */}
      <scrollbox
        flexGrow={1}
        flexShrink={1}
        stickyScroll
        stickyStart="bottom"
        contentOptions={{
          flexDirection: 'column',
          paddingLeft: 0,
          paddingRight: 1,
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        <For each={props.state.rows()}>{row => <ChatRowDispatch row={row} />}</For>
      </scrollbox>

      {/* Approval modal — single-color rows (nested spans broke layout in v0.7.0). */}
      <Show when={props.state.pendingApproval()}>
        <box
          flexDirection="column"
          flexShrink={0}
          borderStyle="rounded"
          borderColor="#f59e0b"
          paddingLeft={2}
          paddingRight={2}
          marginLeft={2}
          marginRight={2}
          marginTop={1}
        >
          <text fg="#fbbf24" wrapMode="word">
            {`⚠  approval needed  ·  ${props.state.pendingApproval()!.request.reason}`}
          </text>
          <text fg="#fde68a" wrapMode="word">
            {summarizeApprovalSubject(props.state.pendingApproval()!.request)}
          </text>
          <text>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#86efac">{'[y]'}</span>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#9ca3af">{' allow once   '}</span>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#86efac">{'[s]'}</span>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#9ca3af">{' allow session   '}</span>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#fca5a5">{'[n]'}</span>
            {/* @ts-expect-error opentui SpanProps omits fg, runtime accepts it */}
            <span fg="#9ca3af">{' deny'}</span>
          </text>
        </box>
      </Show>

      {/* Status hint row above input. Always rendered (no Show wrapper) so
          the row's height never collapses; spinner content swaps between a
          spinner string and a single space (never empty — opentui's text
          renderer chokes on truly-empty children). */}
      <box flexDirection="row" flexShrink={0} paddingLeft={3} paddingRight={2} marginTop={1}>
        <text fg="#67e8f9" flexGrow={1}>
          {props.state.status() === 'thinking'
            ? `${SPINNER_FRAMES[spinnerFrame()]} thinking…`
            : ' '}
        </text>
      </box>

      {/* Input bar — flexShrink=0 + height=3 prevents collapse when chat fills viewport */}
      <box
        flexDirection="row"
        flexShrink={0}
        height={3}
        borderStyle="rounded"
        borderColor="#374151"
        paddingLeft={1}
        paddingRight={1}
        marginLeft={2}
        marginRight={2}
      >
        <text fg="#67e8f9" flexShrink={0}>
          {'> '}
        </text>
        <text wrapMode="word" flexGrow={1} fg="#e5e7eb">
          {props.state.input()}
        </text>
      </box>

      {/* Status footer */}
      <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2}>
        <text fg="#86efac" flexShrink={0}>
          {props.state.identityLabel}
        </text>
        <text fg="#374151" flexShrink={0}>
          {'  ·  '}
        </text>
        <text fg="#9ca3af" flexShrink={0}>
          {props.state.brainLabel}
        </text>
        <text fg="#374151" flexShrink={0}>
          {'  ·  '}
        </text>
        <text fg={props.state.approvalsMode() === 'off' ? '#fbbf24' : '#9ca3af'} flexShrink={0}>
          {`perms: ${props.state.approvalsMode()}`}
        </text>
        <Show when={props.state.usage()}>
          <text fg="#374151" flexShrink={0}>
            {'  ·  '}
          </text>
          <text fg="#9ca3af" flexShrink={0}>
            {formatUsage(props.state.usage())}
          </text>
        </Show>
        <text fg="#374151" flexGrow={1}>
          {''}
        </text>
        <text fg="#4b5563" flexShrink={0}>
          {'ctrl+c exit'}
        </text>
      </box>
    </box>
  )
}
