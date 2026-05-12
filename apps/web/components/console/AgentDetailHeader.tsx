'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { shortAddress } from '@/lib/format'

const TABS = [
  { slug: '', label: 'Identity' },
  { slug: 'memory', label: 'Memory' },
  { slug: 'activity', label: 'Activity' },
  { slug: 'wallet', label: 'Wallet' },
] as const

export function AgentDetailHeader({
  tokenId,
  owner,
  subname,
}: {
  tokenId: bigint
  owner: string
  subname?: string | null
}) {
  const pathname = usePathname()
  const base = `/console/${tokenId.toString()}`

  return (
    <header className="grid gap-7 pb-8 pt-2 sm:gap-9">
      <div>
        <Link
          href="/console"
          className="inline-flex items-center gap-2 text-[13px] tracking-tight text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
        >
          <span aria-hidden>←</span> All agents
        </Link>
      </div>
      <div className="grid grid-cols-[auto_1fr] items-end gap-6 sm:gap-9">
        <span
          className="font-display font-light leading-[0.82] text-[var(--color-ink)]"
          style={{
            fontSize: 'clamp(80px, 9vw, 144px)',
            fontVariationSettings: '"opsz" 144, "SOFT" 0, "WONK" 0',
          }}
          aria-hidden
        >
          {tokenId.toString().padStart(2, '0')}
        </span>
        <div className="grid gap-2 pb-3">
          {subname ? (
            <h1
              className="font-display text-[clamp(28px,3vw,44px)] font-light leading-[1.05] tracking-tight text-[var(--color-ink)]"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
            >
              {subname}
              <span className="text-[var(--color-ink-3)]">.0g</span>
            </h1>
          ) : (
            <h1
              className="font-display text-[clamp(26px,2.8vw,38px)] font-light leading-[1.1] tracking-tight text-[var(--color-ink-2)]"
              style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
            >
              Agent #{tokenId.toString()}
            </h1>
          )}
          <p className="font-mono text-[13px] text-[var(--color-ink-2)]">
            token #{tokenId.toString()} · owner {shortAddress(owner, 10, 8)}
          </p>
        </div>
      </div>

      <nav className="-mx-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--color-border)] pt-5">
        {TABS.map((t) => {
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
