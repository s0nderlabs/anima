'use client'

import type { AgentChainMeta } from '@/lib/chain/inft'
import { formatRelativeTime, shortAddress } from '@/lib/format'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { slug: '', label: 'Identity' },
  { slug: 'memory', label: 'Memory' },
  { slug: 'activity', label: 'Activity' },
  { slug: 'wallet', label: 'Wallet' },
] as const

export function AgentDetailHeader({
  tokenId,
  subname,
  agentEOA,
  meta,
}: {
  tokenId: bigint
  subname?: string | null
  agentEOA?: string | null
  meta?: AgentChainMeta | null
}) {
  const pathname = usePathname()
  const base = `/console/${tokenId.toString()}`

  const nowSec = Math.floor(Date.now() / 1000)
  const lastSyncSecondsAgo = meta ? nowSec - meta.lastSyncAt : null
  const lastSyncToken =
    lastSyncSecondsAgo !== null ? formatRelativeTime(lastSyncSecondsAgo) : null
  const [lastSyncValue, lastSyncWord] = lastSyncToken
    ? (lastSyncToken.split(' ') as [string, string])
    : [null, null]
  const isFresh = lastSyncSecondsAgo !== null && lastSyncSecondsAgo < 86_400

  const activity = (() => {
    if (!meta) return null
    const days = Math.max(1, nowSec - meta.firstSyncAt) / 86400
    const aliveValue = days < 1 ? 'today' : days < 1.5 ? '1d' : `${Math.round(days)}d`
    return {
      syncCount: meta.syncCount,
      syncWord: meta.syncCount === 1 ? 'sync' : 'syncs',
      aliveValue,
    }
  })()

  const dormant = !meta && !agentEOA

  return (
    <header className="grid gap-8 pb-8 pt-2 sm:gap-10">
      <div>
        <Link
          href="/console"
          className="inline-flex items-center gap-2 text-[13px] tracking-tight text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
        >
          <span aria-hidden>←</span> All agents
        </Link>
      </div>

      <div className="grid gap-3">
        {subname ? (
          <h1
            className="font-display font-light leading-[1.0] tracking-tight text-[var(--color-ink)]"
            style={{
              fontSize: 'clamp(48px, 6vw, 88px)',
              fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
            }}
          >
            {subname}
            <span className="text-[var(--color-ink-3)]">.anima.0g</span>
          </h1>
        ) : (
          <h1
            className="font-display font-light leading-[1.0] tracking-tight text-[var(--color-ink-2)]"
            style={{
              fontSize: 'clamp(40px, 5vw, 68px)',
              fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
            }}
          >
            Agent #{tokenId.toString()}
          </h1>
        )}

        {agentEOA ? (
          <p className="font-mono text-[15px] text-[var(--color-ink)]">
            {shortAddress(agentEOA, 10, 8)}
          </p>
        ) : null}

        {activity ? (
          <p className="font-mono text-[13px] text-[var(--color-ink-3)]">
            <span className="text-[var(--color-ink)]">{activity.syncCount}</span>{' '}
            {activity.syncWord} · alive{' '}
            <span className="text-[var(--color-ink-2)]">{activity.aliveValue}</span>
            {lastSyncValue && lastSyncWord ? (
              <>
                {' · last '}
                <span className={isFresh ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'}>
                  {lastSyncValue}
                </span>{' '}
                {lastSyncWord}
              </>
            ) : null}
          </p>
        ) : null}

        {dormant ? (
          <p className="font-mono text-[13px] text-[var(--color-ink-3)]">
            not yet anchored · awaiting first sync
          </p>
        ) : null}
      </div>

      <nav className="-mx-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--color-border)] pt-5">
        {TABS.map(t => {
          const href = t.slug ? `${base}/${t.slug}` : base
          const active = t.slug
            ? pathname === href || pathname.startsWith(`${href}/`)
            : pathname === href
          return (
            <Link
              key={t.label}
              href={href}
              className={`px-3 py-2 text-[14px] font-medium tracking-[-0.005em] transition-colors duration-200 ${
                active
                  ? 'text-[var(--color-ink)] underline decoration-[var(--color-ink)] decoration-[1.5px] underline-offset-[7px]'
                  : 'text-[var(--color-ink-2)] hover:text-[var(--color-ink)]'
              }`}
            >
              {t.label}
            </Link>
          )
        })}
      </nav>
    </header>
  )
}
