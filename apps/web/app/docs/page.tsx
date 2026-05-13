import { DocsMobileNav } from '@/components/docs/DocsMobileNav'
import { getNavTree } from '@/lib/docs'
import Link from 'next/link'

export const metadata = {
  title: 'docs · anima',
  description: 'How anima works, end to end. Install, architecture, every layer.',
}

export default async function DocsOverviewPage() {
  const groups = await getNavTree()
  return (
    <article className="min-w-0">
      <DocsMobileNav groups={groups} activeSlug={null} activeTitle="Overview" activeGroup="DOCS" />
      <header className="mt-6 flex flex-col gap-5 md:mt-0">
        <h1
          className="font-display text-[clamp(40px,5vw,72px)] font-light leading-[1.04] tracking-[-0.018em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
        >
          Run a sovereign agent on 0G.
        </h1>
        <p className="max-w-[60ch] text-[15.5px] leading-relaxed text-[var(--color-ink-2)]">
          Two commands take you from install to a live chat. The chapters that follow walk each
          layer of the harness, the CLI and config reference, and the operator console at /console.
        </p>
      </header>

      <div className="mt-14 flex flex-col gap-14">
        {groups.map((group, gi) => (
          <section
            key={group.name}
            className="grid gap-6 border-t border-[var(--color-border)] pt-10 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-10"
          >
            <div className="flex flex-col gap-2">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.24em] text-[var(--color-ink-3)]">
                Chapter {String(gi + 1).padStart(2, '0')}
              </div>
              <div
                className="font-display text-[clamp(22px,2.4vw,30px)] font-light leading-[1.1] tracking-tight text-[var(--color-ink)]"
                style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
              >
                {group.name}.
              </div>
            </div>
            <ul className="flex flex-col gap-1">
              {group.items.map(item => (
                <li key={item.slug}>
                  <Link
                    href={`/docs/${item.slug}`}
                    className="group block rounded-md px-3 py-3 transition hover:bg-[color-mix(in_oklab,var(--color-ink)_3%,transparent)] sm:-mx-3"
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="font-body text-[18px] text-[var(--color-ink)]">
                        {item.title}
                      </span>
                      <span
                        aria-hidden="true"
                        className="font-mono text-[12px] text-[var(--color-ink-3)] opacity-0 transition group-hover:opacity-100"
                      >
                        →
                      </span>
                    </div>
                    <p className="mt-1 max-w-[60ch] text-[14px] leading-[1.55] text-[var(--color-ink-2)]">
                      {item.description}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer className="mt-20 border-t border-[var(--color-border)] pt-8">
        <p className="text-[14px] leading-relaxed text-[var(--color-ink-2)]">
          The repo README is the GitHub-side companion to this site. Every page footers the source
          files it explains.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-5 text-[13px]">
          <a
            href="https://github.com/s0nderlabs/anima#readme"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
          >
            Full README ↗
          </a>
          <a
            href="https://github.com/s0nderlabs/anima/releases"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
          >
            Changelog ↗
          </a>
          <a
            href="/llms.txt"
            className="font-mono text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
          >
            llms.txt ↗
          </a>
          <a
            href="/llms-full.txt"
            className="font-mono text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
          >
            llms-full.txt ↗
          </a>
        </div>
      </footer>
    </article>
  )
}
