'use client'

import { motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'

export function ClosingCta() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.95, ease: [0.22, 1, 0.36, 1] }}
      className="relative isolate mx-auto w-full max-w-[860px] overflow-hidden rounded-[24px] border border-[var(--color-border)] bg-[var(--color-cream-warm)] px-8 py-16 text-center sm:py-24"
      style={{ boxShadow: '0 60px 120px -70px rgba(50,35,18,0.42)' }}
    >
      <Image
        src="/aurelia/grove.png"
        alt=""
        fill
        aria-hidden
        priority={false}
        quality={70}
        sizes="(min-width: 768px) 860px, 100vw"
        className="-z-10 object-cover opacity-[0.22]"
        style={{ filter: 'blur(50px) saturate(0.85)', transform: 'scale(1.18)' }}
      />
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-[var(--color-cream-warm)]/60 via-transparent to-[var(--color-cream-warm)]/80" />

      <span className="kicker mx-auto justify-center">
        FINIS · CHAPTER IV
      </span>
      <h2 className="font-display mt-6 text-[clamp(40px,6vw,84px)] font-light leading-[0.98] tracking-[-0.02em] text-[var(--color-ink)]">
        Run a <span className="font-italic-serif italic">sovereign</span> agent.
      </h2>
      <p className="mt-5 max-w-md mx-auto text-[16px] leading-relaxed text-[var(--color-ink-2)]">
        Mint once. Anima keeps running.
      </p>

      <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
        <Link
          href="/console"
          className="group inline-flex items-center gap-2 rounded-full bg-[var(--color-ink)] px-7 py-3.5 text-[15px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(26,20,16,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99]"
        >
          <span>Run an agent</span>
          <span aria-hidden className="transition-transform group-hover:translate-x-1">
            →
          </span>
        </Link>
        <Link
          href="https://github.com/s0nderlabs/anima"
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[12px] uppercase tracking-[0.22em] text-[var(--color-ink-2)] underline-offset-4 hover:underline"
        >
          inspect the source ↗
        </Link>
      </div>
    </motion.div>
  )
}
