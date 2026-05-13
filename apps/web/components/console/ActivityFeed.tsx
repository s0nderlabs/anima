'use client'

import { fetchSlots } from '@/lib/chain/inft'
import { decryptMemoryToText } from '@/lib/crypto/memory'
import { shortHash } from '@/lib/format'
import { fetchBlobByRootHash } from '@/lib/storage/og'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import { usePublicClient } from 'wagmi'
import { zgMainnet } from '@/lib/chain/chain'

const brainComponents: Components = {
  p: ({ children }) => (
    <p className="leading-[1.55] [&+p]:mt-2 [&+ul]:mt-1 [&+ol]:mt-1">{children}</p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-[var(--color-ink)]">{children}</strong>
  ),
  em: ({ children }) => <span className="text-[var(--color-ink-2)]">{children}</span>,
  code: ({ children }) => (
    <code className="rounded bg-[var(--color-paper)] px-1 py-[1px] text-[var(--color-ink-2)]">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-paper)] px-3 py-2 text-[13px] leading-[1.5]">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-1.5 grid gap-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 grid list-decimal gap-1 pl-4">{children}</ol>,
  li: ({ children }) => (
    <li className="ml-3.5 list-disc marker:text-[var(--color-ink-3)]">{children}</li>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-ink)]"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-2 border-[var(--color-border)]" />,
  h1: ({ children }) => <p className="font-semibold text-[var(--color-ink)]">{children}</p>,
  h2: ({ children }) => <p className="font-semibold text-[var(--color-ink)]">{children}</p>,
  h3: ({ children }) => <p className="font-semibold text-[var(--color-ink)]">{children}</p>,
  h4: ({ children }) => <p className="font-semibold text-[var(--color-ink)]">{children}</p>,
}

type ActivityKind =
  | 'wake'
  | 'tool-call'
  | 'tool-result'
  | 'brain-response'
  | 'error'
  | 'context-compacted'
  | 'auto-topup'
  | 'unknown'

type ActivityEntry = {
  ts: number
  kind: ActivityKind
  data: unknown
}

type AutoTopupKind = 'topup-fired' | 'topup-failed' | 'wallet-low'
const AUTO_TOPUP_STATUS: Record<AutoTopupKind, { label: string; tone: 'ok' | 'failed' | 'warn' }> = {
  'topup-fired': { label: 'ok', tone: 'ok' },
  'topup-failed': { label: 'failed', tone: 'failed' },
  'wallet-low': { label: 'low', tone: 'warn' },
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'placeholder' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; entries: ActivityEntry[] }

export function ActivityFeed({
  tokenId,
  memoryKey,
}: {
  tokenId: bigint
  memoryKey: CryptoKey
}) {
  const client = usePublicClient({ chainId: zgMainnet.id })
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    if (!client) return
    let alive = true
    fetchSlots(client, tokenId).then(async slots => {
      const activity = slots.find(s => s.name === 'activity-log')
      if (!activity || activity.isBootstrap) {
        if (alive) setState({ kind: 'placeholder' })
        return
      }
      try {
        const bytes = await fetchBlobByRootHash(activity.hash)
        const text = await decryptMemoryToText(bytes, memoryKey)
        const entries = parseJsonl(text)
        if (!alive) return
        setState({ kind: 'ready', entries })
      } catch (err) {
        if (!alive) return
        setState({ kind: 'error', message: (err as Error).message })
      }
    })
    return () => {
      alive = false
    }
  }, [client, tokenId, memoryKey])

  const grouped = useMemo(() => {
    if (state.kind !== 'ready') return null
    return groupByHour(state.entries)
  }, [state])

  if (state.kind === 'loading') {
    return (
      <ActivityShell intro="Pulling the encrypted log from 0G Storage.">
        <p className="font-mono text-[12.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
          Unsealing
        </p>
      </ActivityShell>
    )
  }

  if (state.kind === 'placeholder') {
    return (
      <ActivityShell intro="Nothing anchored to the activity slot yet. Once the agent runs and syncs, the log shows up here." />
    )
  }

  if (state.kind === 'error') {
    return (
      <ActivityShell intro="The activity log could not be read.">
        <p className="max-w-[60ch] font-mono text-[13px] leading-[1.6] text-[var(--color-ink-2)]">
          {state.message}
        </p>
      </ActivityShell>
    )
  }

  if (state.entries.length === 0) {
    return <ActivityShell intro="Sealed log decoded. No entries yet." />
  }

  return (
    <div className="grid gap-12 pt-4">
      <ActivityHeader count={state.entries.length} />
      {grouped?.map((group, gi) => (
        <section key={group.label} className="grid gap-5">
          <div className="flex items-center gap-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
              {group.label}
            </span>
            <div className="h-px flex-1 bg-[var(--color-border)]" />
          </div>
          <ul className="grid gap-3">
            {group.entries.map((entry, ei) => (
              <motion.li
                key={`${entry.ts}-${ei}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: 0.04 + gi * 0.05 + ei * 0.012,
                  duration: 0.6,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                {entry.kind === 'tool-call' ? (
                  <ToolPairRow entry={entry} />
                ) : (
                  <EntryRow entry={entry} />
                )}
              </motion.li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function ActivityTitle() {
  return (
    <h2
      className="font-display text-[clamp(26px,2.6vw,34px)] font-light leading-[1.1] tracking-tight text-[var(--color-ink)]"
      style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
    >
      Activity log
    </h2>
  )
}

function ActivityHeader({ count }: { count: number }) {
  return (
    <header className="grid gap-3">
      <ActivityTitle />
      <p className="max-w-[60ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
        Every wake, tool call, reply, and compaction the agent recorded.{' '}
        <span className="text-[var(--color-ink-3)]">
          {count.toLocaleString()} entries, most recent first.
        </span>
      </p>
    </header>
  )
}

function ActivityShell({ intro, children }: { intro: string; children?: React.ReactNode }) {
  return (
    <div className="grid gap-5 pt-4">
      <ActivityTitle />
      <p className="max-w-[60ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">{intro}</p>
      {children}
    </div>
  )
}

function EntryRow({ entry }: { entry: ActivityEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] items-baseline gap-5">
      <span className="font-mono text-[11.5px] tracking-[0.08em] text-[var(--color-ink-3)]">
        {time}
      </span>
      <div className="min-w-0 text-[var(--color-ink)]">{renderEntry(entry)}</div>
    </div>
  )
}

function renderEntry(entry: ActivityEntry) {
  switch (entry.kind) {
    case 'wake': {
      const d = (entry.data ?? {}) as { source?: string }
      return (
        <span className="font-mono text-[13.5px] leading-[1.5] text-[var(--color-ink-2)]">
          wake{d.source ? ` · ${d.source}` : ''}
        </span>
      )
    }
    case 'tool-call': {
      const d = entry.data as { name?: string; args?: unknown }
      const argsRaw = typeof d.args === 'object' ? JSON.stringify(d.args) : String(d.args ?? '')
      const args = argsRaw === '{}' || argsRaw === '' ? '' : truncate(argsRaw, 110)
      return (
        <span className="block break-words font-mono text-[13.5px] leading-[1.55] text-[var(--color-ink)]">
          <span aria-hidden className="mr-1.5 text-[var(--color-ink-3)]">
            ▸
          </span>
          {d.name ?? 'tool'}
          {args && <span className="text-[var(--color-ink-3)]"> {args}</span>}
        </span>
      )
    }
    case 'tool-result': {
      const d = entry.data as { name?: string; ok?: boolean; result?: unknown; error?: string }
      const ok = d.ok !== false
      const summary = ok
        ? truncate(typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? ''), 140)
        : truncate(d.error ?? 'failed', 140)
      return (
        <span className="block break-words font-mono text-[13.5px] leading-[1.55] text-[var(--color-ink-2)]">
          <span aria-hidden className="mr-1.5 text-[var(--color-ink-3)]">
            ↳
          </span>
          {d.name ?? 'tool'}{' '}
          <span className={ok ? '' : 'underline decoration-[var(--color-ink)] text-[var(--color-ink)]'}>
            {ok ? 'ok' : 'failed'}
          </span>
          <span className="text-[var(--color-ink-3)]"> · {summary}</span>
        </span>
      )
    }
    case 'brain-response': {
      const d = entry.data as { content?: string }
      const content = (d.content ?? '').trim()
      if (!content) {
        return (
          <span className="font-mono text-[13.5px] text-[var(--color-ink-3)]">(empty reply)</span>
        )
      }
      const display = truncate(content, 1200)
      return (
        <div className="font-mono text-[13.5px] leading-[1.55] text-[var(--color-ink)]">
          <ReactMarkdown rehypePlugins={[rehypeSanitize]} components={brainComponents}>
            {display}
          </ReactMarkdown>
        </div>
      )
    }
    case 'error': {
      const d = entry.data as { message?: string }
      return (
        <span className="block break-words font-mono text-[13.5px] leading-[1.55] text-[var(--color-ink)]">
          <span aria-hidden className="mr-1.5 text-[var(--color-ink-3)]">
            !
          </span>
          {truncate(d.message ?? 'error', 200)}
        </span>
      )
    }
    case 'context-compacted':
      return (
        <span className="font-mono text-[13.5px] text-[var(--color-ink-2)]">
          <span aria-hidden className="mr-1.5 text-[var(--color-ink-3)]">
            ✂
          </span>
          context compacted
        </span>
      )
    case 'auto-topup': {
      const d = (entry.data ?? {}) as { kind?: string; message?: string }
      const status = AUTO_TOPUP_STATUS[d.kind as AutoTopupKind] ?? {
        label: d.kind ?? 'fired',
        tone: 'warn' as const,
      }
      const message = d.message ?? ''
      return (
        <span className="flex w-full items-baseline gap-3 font-mono text-[13.5px] leading-[1.55]">
          <span className="shrink-0 whitespace-nowrap text-[var(--color-ink)]">
            <span aria-hidden className="mr-1.5 text-[var(--color-ink-3)]">
              ⚡
            </span>
            auto-topup
          </span>
          <span className="min-w-0 flex-1 truncate text-[var(--color-ink-3)]">{message}</span>
          <span
            className={`shrink-0 w-[64px] whitespace-nowrap text-[11px] uppercase tracking-[0.16em] ${
              status.tone === 'ok'
                ? 'text-[var(--color-ink-3)]'
                : status.tone === 'failed'
                  ? 'text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-2'
                  : 'text-[var(--color-ink-2)]'
            }`}
          >
            {status.label}
          </span>
        </span>
      )
    }
    default:
      return (
        <span className="font-mono text-[12.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          {entry.kind}
        </span>
      )
  }
}

function parseJsonl(text: string): ActivityEntry[] {
  const out: ActivityEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as { ts?: number; kind?: string; data?: unknown }
      if (typeof obj.ts !== 'number' || typeof obj.kind !== 'string') continue
      out.push({ ts: obj.ts, kind: (obj.kind as ActivityKind) || 'unknown', data: obj.data })
    } catch {
      // skip malformed lines
    }
  }
  // Most recent first.
  return out.sort((a, b) => b.ts - a.ts)
}

function groupByHour(entries: ActivityEntry[]) {
  const groups: { label: string; entries: ActivityEntry[] }[] = []
  let currentKey = ''
  for (const entry of entries) {
    const d = new Date(entry.ts)
    const date = d.toLocaleString([], { month: 'short', day: 'numeric' }).toUpperCase()
    const hour = `${String(d.getHours()).padStart(2, '0')}:00`
    const label = `${date} · ${hour}`
    if (label !== currentKey) {
      currentKey = label
      groups.push({ label, entries: [] })
    }
    groups[groups.length - 1].entries.push(entry)
  }
  return groups
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)}…`
}

function summarizeArgs(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v !== 'object') return String(v)
  const obj = v as Record<string, unknown>
  const parts: string[] = []
  for (const [k, val] of Object.entries(obj)) {
    // Skip noise: empty arrays/objects/null/undefined.
    if (val === null || val === undefined) continue
    if (Array.isArray(val) && val.length === 0) continue
    if (typeof val === 'object' && !Array.isArray(val) && Object.keys(val as object).length === 0) continue
    parts.push(`${k}=${prettyArgValue(val)}`)
    if (parts.join(', ').length > 80) break
  }
  return parts.join(', ')
}

function prettyArgValue(v: unknown): string {
  if (typeof v === 'string') {
    if (/^0x[0-9a-fA-F]{20,}$/.test(v)) return shortHash(v, 6, 4)
    return v.length > 28 ? `${v.slice(0, 26)}…` : v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.length > 3 ? `[${v.length} items]` : JSON.stringify(v)
  const json = JSON.stringify(v)
  return json.length > 30 ? `${json.slice(0, 28)}…}` : json
}

function formatJson(v: unknown): string {
  if (v === null || v === undefined) return '(empty)'
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2)
      } catch {
        return v
      }
    }
    return v
  }
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function asResultText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  return formatJson(v)
}

function ToolPairRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false)
  const data = (entry.data ?? {}) as {
    call?: { name?: string; args?: unknown } | null
    result?: { ok?: boolean; data?: unknown; error?: string } | null
    blocked?: boolean
    autoEscalated?: boolean
  }
  const call = data.call ?? null
  const result = data.result ?? null
  const time = new Date(entry.ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const name = call?.name ?? 'tool'
  const args = call?.args
  const argsHas =
    args !== undefined && args !== null && !(typeof args === 'object' && Object.keys(args as object).length === 0)
  const argsShort = argsHas ? summarizeArgs(args) : ''
  const hasResult = !!result
  const ok = !result || result.ok !== false
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] items-baseline gap-5">
      <span className="font-mono text-[11.5px] tracking-[0.08em] text-[var(--color-ink-3)]">
        {time}
      </span>
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className="group flex w-full items-baseline gap-3 rounded py-0.5 text-left transition hover:bg-[var(--color-ink)]/[0.035]"
        >
          <span className="shrink-0 whitespace-nowrap font-mono text-[13.5px] leading-[1.55] text-[var(--color-ink)]">
            <span aria-hidden className="mr-1.5 text-[var(--color-ink-3)]">
              ▸
            </span>
            {name}
          </span>
          {argsShort && (
            <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] leading-[1.55] text-[var(--color-ink-3)]">
              {argsShort}
            </span>
          )}
          {!argsShort && <span className="min-w-0 flex-1" aria-hidden />}
          {hasResult && (
            <span
              className={`shrink-0 w-[64px] whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.16em] ${
                ok
                  ? 'text-[var(--color-ink-3)]'
                  : 'text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-2'
              }`}
            >
              {ok ? 'ok' : 'failed'}
            </span>
          )}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              style={{ overflow: 'hidden' }}
            >
              <div className="mt-3 grid gap-4 pb-2">
                <ExpandBlock label="args" body={argsHas ? formatJson(args) : '(empty)'} />
                {hasResult && result && (
                  <ExpandBlock
                    label={ok ? 'result' : 'error'}
                    body={
                      ok
                        ? asResultText(result.data) || '(empty)'
                        : (result.error ?? 'failed')
                    }
                    tone={ok ? 'default' : 'failed'}
                  />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function ExpandBlock({
  label,
  body,
  tone = 'default',
}: {
  label: string
  body: string
  tone?: 'default' | 'failed'
}) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-4">
      <p className="pt-[3px] font-mono text-[10.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
        {label}
      </p>
      <pre
        className={`overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.65] ${
          tone === 'failed' ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
        }`}
      >
        {body}
      </pre>
    </div>
  )
}
