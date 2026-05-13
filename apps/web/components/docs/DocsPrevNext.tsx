import Link from 'next/link'
import type { AdjacentDocs } from '@/lib/docs'

export function DocsPrevNext({ prev, next }: AdjacentDocs) {
  if (!prev && !next) return null
  return (
    <nav
      aria-label="Adjacent docs"
      className="mt-16 grid gap-4 border-t border-[var(--color-border)] pt-8 sm:grid-cols-2"
    >
      <div>
        {prev && (
          <Link
            href={`/docs/${prev.slug}`}
            className="group block rounded-md px-4 py-3 transition hover:bg-[color-mix(in_oklab,var(--color-ink)_3%,transparent)]"
          >
            <div className="font-mono text-[10.5px] uppercase tracking-[0.24em] text-[var(--color-ink-3)]">
              ← Previous
            </div>
            <div className="mt-1 font-body text-[16px] text-[var(--color-ink)] transition group-hover:text-[var(--color-ink)]">
              {prev.title}
            </div>
          </Link>
        )}
      </div>
      <div className="sm:text-right">
        {next && (
          <Link
            href={`/docs/${next.slug}`}
            className="group block rounded-md px-4 py-3 transition hover:bg-[color-mix(in_oklab,var(--color-ink)_3%,transparent)]"
          >
            <div className="font-mono text-[10.5px] uppercase tracking-[0.24em] text-[var(--color-ink-3)]">
              Next →
            </div>
            <div className="mt-1 font-body text-[16px] text-[var(--color-ink)] transition group-hover:text-[var(--color-ink)]">
              {next.title}
            </div>
          </Link>
        )}
      </div>
    </nav>
  )
}
