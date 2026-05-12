'use client'

import { fetchSlots } from '@/lib/chain/inft'
import { decryptMemoryToText } from '@/lib/crypto/memory'
import { fetchBlobByRootHash } from '@/lib/storage/og'
import { motion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { zgMainnet } from '@/lib/chain/chain'

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
      <div className="grid gap-3 pt-6">
        <span className="kicker">ACTIVITY · UNSEALING</span>
        <p className="text-[15.5px] leading-[1.6] text-[var(--color-ink-2)]">
          Pulling the encrypted log from 0G Storage.
        </p>
      </div>
    )
  }

  if (state.kind === 'placeholder') {
    return (
      <div className="grid gap-3 pt-6">
        <span className="kicker">ACTIVITY · NOT YET</span>
        <p className="text-[15.5px] leading-[1.6] text-[var(--color-ink-2)]">
          Nothing anchored to the activity slot yet. Once the agent runs and syncs, the log shows up
          here.
        </p>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="grid gap-3 pt-6">
        <span className="kicker">ACTIVITY · ERROR</span>
        <p className="font-mono text-[12.5px] uppercase tracking-[0.22em] text-[var(--color-ink-2)]">
          {state.message}
        </p>
      </div>
    )
  }

  if (state.entries.length === 0) {
    return (
      <div className="grid gap-3 pt-6">
        <span className="kicker">ACTIVITY · EMPTY</span>
        <p className="text-[15.5px] leading-[1.6] text-[var(--color-ink-2)]">
          Sealed log decoded. No entries yet.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-10 pt-4">
      <div>
        <span className="kicker">ACTIVITY · {state.entries.length} ENTRIES</span>
        <p className="mt-3 max-w-[60ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
          Every wake, tool call, reply, and compaction the agent recorded. Most recent first.
        </p>
      </div>
      {grouped?.map((group, gi) => (
        <section key={group.label} className="grid gap-3">
          <span className="kicker">{group.label}</span>
          <ul className="grid gap-2">
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
                <EntryRow entry={entry} />
              </motion.li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function EntryRow({ entry }: { entry: ActivityEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const tsColor = 'text-[var(--color-ink-3)]'
  return (
    <div className="grid grid-cols-[78px_minmax(0,1fr)] items-start gap-4">
      <span className={`pt-[2px] font-mono text-[11.5px] uppercase tracking-[0.18em] ${tsColor}`}>
        {time}
      </span>
      <div className="text-[14.5px] leading-[1.55] text-[var(--color-ink)]">
        {renderEntry(entry)}
      </div>
    </div>
  )
}

function renderEntry(entry: ActivityEntry) {
  switch (entry.kind) {
    case 'wake':
      return (
        <span>
          <span className="font-mono text-[var(--color-ink-2)]">WAKE</span>
          {entry.data && typeof entry.data === 'object'
            ? `  ${(entry.data as { source?: string }).source ?? ''}`
            : ''}
        </span>
      )
    case 'tool-call': {
      const d = entry.data as { name?: string; args?: unknown }
      const args = typeof d.args === 'object' ? JSON.stringify(d.args) : String(d.args ?? '')
      return (
        <span className="font-mono text-[14px]">
          ▸ {d.name ?? 'tool'}
          <span className="text-[var(--color-ink-3)]">({truncate(args, 90)})</span>
        </span>
      )
    }
    case 'tool-result': {
      const d = entry.data as { name?: string; ok?: boolean; result?: unknown; error?: string }
      const ok = d.ok !== false
      const summary = ok
        ? truncate(typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? ''), 120)
        : truncate(d.error ?? 'failed', 120)
      return (
        <span className="font-mono text-[14px]">
          ↳ {d.name ?? 'tool'}{' '}
          <span className={ok ? 'text-[var(--color-ink-2)]' : 'text-[var(--color-ink)] underline'}>
            {ok ? 'ok' : 'failed'}
          </span>{' '}
          <span className="text-[var(--color-ink-3)]">· {summary}</span>
        </span>
      )
    }
    case 'brain-response': {
      const d = entry.data as { content?: string }
      const content = (d.content ?? '').trim()
      return (
        <span className="font-italic-serif text-[17px] italic leading-[1.5] text-[var(--color-ink)]">
          {truncate(content, 320) || <em className="text-[var(--color-ink-3)]">(empty reply)</em>}
        </span>
      )
    }
    case 'error': {
      const d = entry.data as { message?: string }
      return (
        <span>
          <span className="font-mono text-[var(--color-ink-2)]">ERROR</span>{' '}
          <span className="text-[var(--color-ink-2)]">{truncate(d.message ?? '', 200)}</span>
        </span>
      )
    }
    case 'context-compacted':
      return (
        <span className="font-mono text-[14px] text-[var(--color-ink-2)]">✂ context compacted</span>
      )
    case 'auto-topup': {
      const d = entry.data as { kind?: string; tx?: string }
      return (
        <span className="font-mono text-[14px] text-[var(--color-ink-2)]">
          ⚡ auto-topup · {d.kind ?? 'fired'}
          {d.tx ? ` · ${d.tx.slice(0, 10)}…` : ''}
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
  for (const e of entries) {
    const d = new Date(e.ts)
    const label = d
      .toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        hour12: false,
      })
      .toUpperCase()
    if (label !== currentKey) {
      currentKey = label
      groups.push({ label, entries: [] })
    }
    groups[groups.length - 1].entries.push(e)
  }
  return groups
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)}…`
}
