'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { NavGroup } from '@/lib/docs'

interface Props {
  groups: NavGroup[]
}

export function DocsSidebar({ groups }: Props) {
  const pathname = usePathname()
  const match = pathname?.match(/^\/docs\/([^/]+)/)
  const activeSlug = match?.[1] ?? null

  return (
    <nav aria-label="Docs navigation" className="flex flex-col gap-7">
      <Link
        href="/docs"
        className={`font-mono text-[11px] uppercase tracking-[0.22em] transition ${
          pathname === '/docs'
            ? 'text-[var(--color-ink)]'
            : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
        }`}
      >
        Overview
      </Link>
      {groups.map(group => (
        <div key={group.name} className="flex flex-col gap-3">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.24em] text-[var(--color-ink-3)]">
            {group.name}
          </div>
          <ul className="flex flex-col gap-0.5">
            {group.items.map(item => {
              const isActive = item.slug === activeSlug
              return (
                <li key={item.slug}>
                  <Link
                    href={`/docs/${item.slug}`}
                    aria-current={isActive ? 'page' : undefined}
                    className={`block rounded-md px-3 py-2 text-[13.5px] leading-[1.4] transition ${
                      isActive
                        ? 'bg-[color-mix(in_oklab,var(--color-ink)_4%,transparent)] text-[var(--color-ink)]'
                        : 'text-[var(--color-ink-2)] hover:bg-[color-mix(in_oklab,var(--color-ink)_3%,transparent)] hover:text-[var(--color-ink)]'
                    }`}
                  >
                    {item.title}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
