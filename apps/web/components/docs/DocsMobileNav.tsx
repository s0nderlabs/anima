'use client'

import type { NavGroup } from '@/lib/docs'
import Link from 'next/link'
import { useId } from 'react'

interface Props {
  groups: NavGroup[]
  activeSlug: string | null
  activeTitle: string | null
  activeGroup: string | null
}

export function DocsMobileNav({ groups, activeSlug, activeTitle, activeGroup }: Props) {
  const id = useId()
  return (
    <details className="group relative md:hidden">
      <summary
        id={id}
        className="flex cursor-pointer list-none items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-paper)] px-4 py-3 text-[13px] text-[var(--color-ink)] [&::-webkit-details-marker]:hidden"
      >
        <span className="flex flex-col gap-0.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
            {activeGroup ?? 'DOCS'}
          </span>
          <span className="font-body text-[15px] text-[var(--color-ink)]">
            {activeTitle ?? 'Documentation'}
          </span>
        </span>
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          className="transition-transform group-open:rotate-180"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-paper)] p-4">
        <div className="flex flex-col gap-5">
          <Link
            href="/docs"
            aria-current={activeSlug === null ? 'page' : undefined}
            className={`block rounded-md px-3 py-2 text-[13.5px] leading-[1.4] transition ${
              activeSlug === null
                ? 'bg-[color-mix(in_oklab,var(--color-ink)_4%,transparent)] text-[var(--color-ink)]'
                : 'text-[var(--color-ink-2)] hover:text-[var(--color-ink)]'
            }`}
          >
            Overview
          </Link>
          {groups.map(group => (
            <div key={group.name} className="flex flex-col gap-2">
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
                            : 'text-[var(--color-ink-2)] hover:text-[var(--color-ink)]'
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
        </div>
      </div>
    </details>
  )
}
