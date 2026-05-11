'use client'

import { motion } from 'framer-motion'

const lineVariants = {
  hidden: { opacity: 0, y: 24, filter: 'blur(8px)' },
  show: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.85, ease: [0.22, 1, 0.36, 1] },
  },
}

export function V1Opener() {
  return (
    <section
      id="layer-opener"
      className="relative isolate flex min-h-screen items-center overflow-hidden py-[var(--section-py)]"
    >
      <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 sm:px-8">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.5 }}
          transition={{ staggerChildren: 0.16, delayChildren: 0.1 }}
          className="font-display flex flex-col gap-3 text-[clamp(56px,10vw,140px)] font-light leading-[0.96] tracking-[-0.022em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 144, "SOFT" 30, "WONK" 0' }}
        >
          <motion.span variants={lineVariants}>No host.</motion.span>
          <motion.span variants={lineVariants}>No central operator.</motion.span>
          <motion.div
            variants={lineVariants}
            className="flex flex-wrap items-baseline gap-x-5 gap-y-3"
          >
            <span className="font-italic-serif italic text-[var(--color-ink)]">Fully on</span>
            <motion.span
              initial={{ opacity: 0, scale: 0.92 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: 0.9, delay: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="inline-flex translate-y-[0.04em] items-baseline"
            >
              <ZeroGMark />
            </motion.span>
            <span aria-hidden>.</span>
          </motion.div>
        </motion.div>

        <motion.p
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.7, delay: 0.9 }}
          className="mt-12 max-w-2xl text-[15px] leading-relaxed text-[var(--color-ink-2)]"
        >
          Identity, brain, memory, limbs, comms, and economy, every layer of the harness lives on
          decentralized infrastructure. Mint once. Walk away. The agent persists.
        </motion.p>
      </div>
    </section>
  )
}

// 0G wordmark inline SVG (real path data from the brandkit). Scales to headline
// cap height via h-[0.78em], stays sharp at any size, no next/image quirks.
function ZeroGMark() {
  return (
    <svg
      role="img"
      aria-label="0G"
      viewBox="0 0 248 120"
      xmlns="http://www.w3.org/2000/svg"
      className="block h-[0.72em] w-auto"
      fill="currentColor"
      style={{ color: 'var(--color-ink)' }}
    >
      <path d="M247.994 63.4189C246.43 94.8449 220.164 119.85 187.993 119.85C154.815 119.85 127.918 93.2547 127.918 60.4481C127.918 27.6413 154.815 1.04688 187.993 1.04688C219.144 1.04688 244.758 24.491 247.772 54.5085H220.49C217.665 39.3007 204.19 27.7779 187.994 27.7779C169.745 27.7779 154.952 42.4049 154.952 60.4481C154.952 78.4922 169.745 93.1192 187.994 93.1192C202.003 93.1192 213.974 84.498 218.782 72.3291H172.974V63.4189H247.994Z" />
      <path d="M19.7719 104.311C43.3526 125.438 79.8058 124.755 102.555 102.262C126.015 79.064 126.015 41.4537 102.555 18.2555C79.0936 -4.94194 41.0564 -4.94194 17.5956 18.2555C-4.43161 40.0359 -5.77756 74.5211 13.5575 97.8546L32.8486 78.78C23.9713 66.0513 25.2587 48.4817 36.7116 37.1576C49.6149 24.3986 70.5357 24.3986 83.4394 37.1576C96.3419 49.9163 96.3419 70.6022 83.4394 83.3611C73.5328 93.1562 58.9014 95.4318 46.7999 90.1865L79.1909 58.1583L72.8191 51.8587L19.7719 104.311Z" />
    </svg>
  )
}
