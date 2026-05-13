import Link from 'next/link'

export function DocsNavbar() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 bg-[var(--color-cream)] pt-5 sm:pt-6">
      <div className="mx-auto flex h-[56px] w-full max-w-[var(--container-wrap)] items-center px-6 sm:px-8">
        <Link
          href="/"
          className="font-wordmark text-[24px] leading-none tracking-[-0.02em] text-[var(--color-ink)]"
          aria-label="anima home"
        >
          anima<span className="text-[var(--color-ink-3)]"> · docs</span>
        </Link>
      </div>
    </header>
  )
}
