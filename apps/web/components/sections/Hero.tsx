'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { HeroCanvas } from './HeroCanvas'

const lineVariants = {
  hidden: { opacity: 0, y: 26, filter: 'blur(8px)' },
  show: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.85, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
}

export function Hero() {
  return (
    <section
      id="hero"
      className="relative isolate flex flex-col bg-[var(--color-cream)] pt-20 sm:pt-24"
      aria-labelledby="hero-headline"
    >
      <div className="mx-auto flex w-full max-w-[var(--container-wrap)] flex-col items-center px-6 text-center sm:px-8">
        <motion.h1
          id="hero-headline"
          initial="hidden"
          animate="show"
          transition={{ staggerChildren: 0.14, delayChildren: 0.05 }}
          className="font-display text-[clamp(38px,4.8vw,68px)] font-light leading-[1] tracking-[-0.02em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
        >
          <motion.span variants={lineVariants} className="block">
            A fully{' '}
            <span className="font-italic-serif italic text-[var(--color-ink)]">sovereign</span>
          </motion.span>
          <motion.span variants={lineVariants} className="block">
            agentic harness.
          </motion.span>
        </motion.h1>

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="mt-6 flex items-center justify-center sm:mt-8 lg:mt-9"
        >
          <Link
            href="/console"
            className="group inline-flex items-center gap-2 rounded-full bg-[var(--color-ink)] px-8 py-3.5 text-[15px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(16,15,9,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99]"
          >
            <span>Run an agent</span>
            <span aria-hidden className="transition-transform group-hover:translate-x-1">
              →
            </span>
          </Link>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1, delay: 0.95, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto mt-8 w-full max-w-[1544px] px-4 pb-12 sm:mt-11 sm:px-8 sm:pb-16 lg:mt-12"
      >
        <HeroCanvas />
      </motion.div>
    </section>
  )
}
