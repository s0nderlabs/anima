import Link from 'next/link'
import { Navbar } from '@/components/Navbar'

export const metadata = {
  title: 'console · anima',
  description: 'Operator console for anima. Coming soon.',
}

export default function ConsolePage() {
  return (
    <main className="relative min-h-screen bg-[var(--color-cream)] text-[var(--color-ink)]">
      <Navbar />
      <section className="mx-auto flex min-h-[80vh] w-full max-w-[var(--container-narrow)] flex-col items-start justify-center gap-8 px-6 py-32">
        <span className="kicker">CONSOLE · COMING SOON</span>
        <h1 className="font-display text-[clamp(40px,5vw,72px)] font-light leading-[1.05] tracking-tight">
          The operator console is{' '}
          <span className="font-italic-serif italic text-[var(--color-ink-2)]">in flight</span>.
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-[var(--color-ink-2)]">
          Until the wallet-connected dashboard ships, run anima the way it was designed: as a
          terminal-first, on-chain agent on your own machine.
        </p>
        <div className="font-mono text-[15px] leading-7 text-[var(--color-ink)]">
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)] px-5 py-4 shadow-sm">
            <span className="select-none text-[var(--color-ink-3)]">$ </span>
            bun add -g @s0nderlabs/anima
          </div>
          <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)] px-5 py-4 shadow-sm">
            <span className="select-none text-[var(--color-ink-3)]">$ </span>
            anima init
          </div>
        </div>
        <div className="flex items-center gap-4 pt-2">
          <Link
            href="/"
            className="font-mono text-sm uppercase tracking-[0.18em] text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
          >
            ← back to landing
          </Link>
          <Link
            href="https://github.com/s0nderlabs/anima"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-sm uppercase tracking-[0.18em] text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
          >
            github ↗
          </Link>
        </div>
      </section>
    </main>
  )
}
