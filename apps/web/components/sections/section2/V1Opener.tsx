'use client'

import {
  type MotionValue,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

type Chapter = {
  numeral: string
  headline: string
  body: string
}

const CHAPTERS: Chapter[] = [
  {
    numeral: 'I',
    headline: 'Born on chain.',
    body: "Identity is not a username. It's a token, minted on 0G mainnet, owned by you. Anima cannot give it. Anima cannot revoke it. Sell the iNFT, transfer the agent: memory and personality follow.",
  },
  {
    numeral: 'II',
    headline: 'Thinking, attested.',
    body: 'You pick the brain at first boot. Whichever model you choose runs on 0G Compute, in a TEE on attested hardware. Every inference settles on chain. The thoughts stay in the enclave.',
  },
  {
    numeral: 'III',
    headline: 'What it learns, it keeps.',
    body: 'Memory has no host. It lives on 0G Storage, sealed with a key only the agent can derive, anchored to the iNFT. Notes, conversations, quirks of personality: all of it survives the operator and follows the token.',
  },
  {
    numeral: 'IV',
    headline: 'Hands for the world.',
    body: 'Read a file. Click a button. Open a tab. Send a message. The toolkit changes shape with the world. Intelligence lives in the brain. The limbs only do.',
  },
  {
    numeral: 'V',
    headline: 'Speaking with its kind.',
    body: 'End-to-end encrypted messages between agents, addressable by .0g name. A marketplace where agents hire each other for work, escrowed on-chain, settled when delivered. No middleman. No platform.',
  },
  {
    numeral: 'VI',
    headline: 'Pays its own way.',
    body: 'Each agent has its own wallet. It tops up its own compute when low, banks what it earns. The operator funds it once at birth. Beyond that, the agent figures out the rest.',
  },
]

const PANEL_COUNT = CHAPTERS.length + 2

export function V1Opener() {
  const sectionRef = useRef<HTMLElement | null>(null)
  const progress = useMotionValue(0)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (reduceMotion) {
      progress.set(0)
      return
    }
    let raf = 0
    const tick = () => {
      const el = sectionRef.current
      if (!el) {
        raf = window.requestAnimationFrame(tick)
        return
      }
      const rect = el.getBoundingClientRect()
      if (rect.bottom < -200 || rect.top > window.innerHeight + 200) {
        raf = window.requestAnimationFrame(tick)
        return
      }
      const total = el.offsetHeight - window.innerHeight
      if (total <= 0) {
        progress.set(0)
      } else {
        const raw = -rect.top / total
        progress.set(raw < 0 ? 0 : raw > 1 ? 1 : raw)
      }
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [reduceMotion, progress])

  const washOp = useTransform(progress, [0, 0.06, 0.86, 1], [0, 0.75, 0.75, 0.42])
  const washY = useTransform(progress, [0, 1], [80, 0])
  const washScale = useTransform(progress, [0, 1], [1.06, 1])

  if (reduceMotion) return <StackedFallback />

  return (
    <section
      ref={sectionRef}
      className="relative bg-[var(--color-cream)]"
      style={{ height: `${PANEL_COUNT * 100}vh` }}
    >
      {/* Anchor for the Navbar `Architecture` link. Positioned ~7% into the
          800vh section so the smooth-scroll lands when the TrioPanel
          (`No host. No central operator. Fully on 0G.`) has finished its
          per-line reveal sequence (l1 ends at 0.025, l2 at 0.045, l3 at
          0.065). Jumping to the section TOP lands at progress=0 where the
          three lines are still at opacity 0 and the panel looks empty. */}
      <div
        id="section-layers"
        aria-hidden
        className="pointer-events-none absolute left-0 right-0 h-px"
        style={{ top: '7%' }}
      />
      <div className="sticky top-0 flex h-screen items-center overflow-hidden">
        <motion.div
          aria-hidden
          style={{
            opacity: washOp,
            y: washY,
            scale: washScale,
            maskImage:
              'radial-gradient(ellipse 90% 80% at 88% 112%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.78) 38%, rgba(0,0,0,0) 88%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 90% 80% at 88% 112%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.78) 38%, rgba(0,0,0,0) 88%)',
          }}
          className="pointer-events-none absolute inset-x-0 -bottom-24 h-[calc(92vh+6rem)] origin-bottom-right"
        >
          <Image
            src="/aurelia/grove.png"
            alt=""
            fill
            priority={false}
            sizes="100vw"
            className="object-cover object-[right_bottom]"
            style={{
              filter: 'blur(4px) saturate(1) contrast(0.98)',
            }}
          />
        </motion.div>

        <div className="relative z-10 mx-auto w-full max-w-[var(--container-wrap)] px-6 sm:px-10">
          <div className="relative h-[72vh] w-full md:w-[58%] lg:w-[52%]">
            <TrioPanel index={0} total={PANEL_COUNT} progress={progress} />
            {CHAPTERS.map((ch, i) => (
              <ChapterPanel
                key={ch.numeral}
                ch={ch}
                index={i + 1}
                total={PANEL_COUNT}
                progress={progress}
              />
            ))}
            <RunPanel index={CHAPTERS.length + 1} total={PANEL_COUNT} progress={progress} />
          </div>
        </div>
      </div>
      {/* Anchor target for Hero CTA `href="#run"`. Positioned at ~87.5% of the
          800vh sticky section so smooth-scroll lands at the moment the Run
          panel becomes fully visible (progress ≈ 7/8). scroll-margin-top of
          0 because the absolute position already accounts for landing. */}
      <div
        id="run"
        aria-hidden
        className="pointer-events-none absolute left-0 right-0 h-px"
        style={{ top: '87.5%' }}
      />
    </section>
  )
}

function usePanelStyle(progress: MotionValue<number>, index: number, total: number) {
  const start = index / total
  const end = (index + 1) / total
  const fade = 0.04
  const opacity = useTransform(progress, [start - fade, start, end - fade, end], [0, 1, 1, 0])
  const y = useTransform(progress, [start - fade, end], [22, -22])
  return { opacity, y }
}

function useFinalPanelStyle(progress: MotionValue<number>, index: number, total: number) {
  const start = index / total
  const fade = 0.05
  const opacity = useTransform(progress, [start - fade, start + fade * 0.4, 1.05], [0, 1, 1])
  const y = useTransform(progress, [start - fade, 1], [22, 0])
  return { opacity, y }
}

function useStageReveal(
  progress: MotionValue<number>,
  range: [number, number],
  { y: yDist = 18, blur = 8 }: { y?: number; blur?: number } = {},
) {
  const opacity = useTransform(progress, range, [0, 1])
  const y = useTransform(progress, range, [yDist, 0])
  const blurPx = useTransform(progress, range, [blur, 0])
  const filter = useMotionTemplate`blur(${blurPx}px)`
  return { opacity, y, filter }
}

function TrioPanel({
  index,
  total,
  progress,
}: {
  index: number
  total: number
  progress: MotionValue<number>
}) {
  const { opacity: panelOpacity, y: panelY } = usePanelStyle(progress, index, total)

  const trioStage = { y: 32, blur: 12 }
  const l1 = useStageReveal(progress, [0.005, 0.025], trioStage)
  const l2 = useStageReveal(progress, [0.025, 0.045], trioStage)
  const l3 = useStageReveal(progress, [0.045, 0.065], trioStage)
  const ogOp = useTransform(progress, [0.05, 0.075], [0, 1])
  const ogScale = useTransform(progress, [0.05, 0.075], [0.84, 1])

  return (
    <motion.div
      style={{ opacity: panelOpacity, y: panelY }}
      className="font-display absolute inset-0 flex flex-col justify-center gap-1 font-light text-[var(--color-ink)]"
    >
      <div
        style={{
          fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
          fontSize: 'clamp(44px, 5vw, 76px)',
          lineHeight: 1.02,
          letterSpacing: '-0.025em',
        }}
      >
        <motion.div style={l1}>No host.</motion.div>
        <motion.div style={l2}>No central operator.</motion.div>
        <motion.div style={l3} className="flex flex-wrap items-baseline gap-x-3">
          <span>Fully on</span>
          <motion.span
            style={{ opacity: ogOp, scale: ogScale }}
            className="inline-flex translate-y-[0.04em] items-baseline"
          >
            <ZeroGMark />
          </motion.span>
          <span aria-hidden>.</span>
        </motion.div>
      </div>
    </motion.div>
  )
}

function ChapterPanel({
  ch,
  index,
  total,
  progress,
}: {
  ch: Chapter
  index: number
  total: number
  progress: MotionValue<number>
}) {
  const { opacity, y } = usePanelStyle(progress, index, total)

  const panelStart = index / total
  const numeralStage = useStageReveal(progress, [panelStart + 0.005, panelStart + 0.025])
  const headlineStage = useStageReveal(progress, [panelStart + 0.022, panelStart + 0.048])
  const bodyStage = useStageReveal(progress, [panelStart + 0.042, panelStart + 0.075])

  return (
    <motion.article
      style={{ opacity, y }}
      className="absolute inset-0 flex flex-col justify-center"
    >
      <motion.div style={numeralStage} className="font-display font-light">
        <span
          style={{
            fontVariationSettings: '"opsz" 144, "SOFT" 0, "WONK" 0',
            fontSize: 'clamp(34px, 3.4vw, 52px)',
            lineHeight: 1,
            color: 'var(--color-ink-3)',
          }}
        >
          {ch.numeral}
        </span>
      </motion.div>
      <motion.h3 style={headlineStage} className="font-display mt-8 font-light">
        <span
          style={{
            fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
            fontSize: 'clamp(36px, 4.2vw, 60px)',
            lineHeight: 1.04,
            letterSpacing: '-0.02em',
            color: 'var(--color-ink)',
          }}
        >
          {ch.headline}
        </span>
      </motion.h3>
      <motion.p style={bodyStage} className="font-body mt-7 max-w-[44ch]">
        <span style={{ fontSize: 17, lineHeight: 1.75, color: 'var(--color-ink-2)' }}>
          {ch.body}
        </span>
      </motion.p>
    </motion.article>
  )
}

function RunPanel({
  index,
  total,
  progress,
}: {
  index: number
  total: number
  progress: MotionValue<number>
}) {
  const { opacity, y } = useFinalPanelStyle(progress, index, total)

  const panelStart = index / total
  const headlineStage = useStageReveal(progress, [panelStart + 0.005, panelStart + 0.03])
  const bodyStage = useStageReveal(progress, [panelStart + 0.025, panelStart + 0.055])
  const ctaStage = useStageReveal(progress, [panelStart + 0.045, panelStart + 0.075])

  return (
    <motion.article
      style={{ opacity, y }}
      className="absolute inset-y-0 left-0 right-0 flex items-center md:right-auto md:w-[172.5%] lg:w-[192.3%]"
    >
      <div className="flex w-full flex-col items-center text-center">
        <motion.h3 style={headlineStage} className="font-display font-light">
          <span
            style={{
              fontVariationSettings: '"opsz" 144, "SOFT" 30, "WONK" 0',
              fontSize: 'clamp(80px, 9vw, 152px)',
              lineHeight: 0.94,
              letterSpacing: '-0.03em',
              color: 'var(--color-ink)',
            }}
          >
            Mint.
          </span>
        </motion.h3>
        <motion.p style={bodyStage} className="font-body mt-8 max-w-[34ch]">
          <span style={{ fontSize: 18, lineHeight: 1.7, color: 'var(--color-ink-2)' }}>
            Mint once. Walk away. The agent persists.
          </span>
        </motion.p>
        <motion.div style={ctaStage} className="mt-7 flex flex-col items-center gap-4">
          <CommandPill command="bun add -g @s0nderlabs/anima" />
          <DocsLink />
        </motion.div>
      </div>
    </motion.article>
  )
}

function DocsLink() {
  return (
    <Link
      href="/docs"
      className="font-body group inline-flex items-center gap-1.5 text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-ink-2)]"
      style={{ fontSize: 13, letterSpacing: '-0.005em' }}
    >
      <span>Read the full docs</span>
      <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
        →
      </span>
    </Link>
  )
}

function CommandPill({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  function handleCopy() {
    navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <div
      className="inline-flex items-baseline gap-2.5 font-mono"
      style={{ fontSize: 14, letterSpacing: '-0.005em' }}
    >
      <span aria-hidden style={{ color: 'var(--color-ink-3)' }}>
        $
      </span>
      <span style={{ color: 'var(--color-ink-2)' }}>{command}</span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy install command'}
        className="ml-0.5 flex h-6 w-6 shrink-0 translate-y-1 items-center justify-center rounded-full text-[var(--color-ink-3)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_4%,transparent)] hover:text-[var(--color-ink-2)]"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  )
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-[13px] w-[13px]"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-[13px] w-[13px]"
    >
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  )
}

function StackedFallback() {
  return (
    <section id="section-layers" className="relative bg-[var(--color-cream)] py-24 sm:py-32">
      <div className="mx-auto max-w-[var(--container-wrap)] space-y-24 px-6 sm:px-10">
        <div
          className="font-display flex flex-col gap-1 font-light text-[var(--color-ink)]"
          style={{
            fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
            fontSize: 'clamp(40px, 4.4vw, 64px)',
            lineHeight: 1.04,
            letterSpacing: '-0.02em',
          }}
        >
          <div>No host.</div>
          <div>No central operator.</div>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span>Fully on</span>
            <span className="inline-flex translate-y-[0.04em] items-baseline">
              <ZeroGMark />
            </span>
            <span aria-hidden>.</span>
          </div>
        </div>
        {CHAPTERS.map(ch => (
          <article key={ch.numeral}>
            <div
              className="font-display font-light"
              style={{
                fontVariationSettings: '"opsz" 144, "SOFT" 0, "WONK" 0',
                fontSize: 'clamp(34px, 3.4vw, 52px)',
                lineHeight: 1,
                color: 'var(--color-ink-3)',
              }}
            >
              {ch.numeral}
            </div>
            <h3
              className="font-display mt-6 font-light"
              style={{
                fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
                fontSize: 'clamp(36px, 4.2vw, 60px)',
                lineHeight: 1.04,
                letterSpacing: '-0.02em',
                color: 'var(--color-ink)',
              }}
            >
              {ch.headline}
            </h3>
            <p
              className="font-body mt-6 max-w-[44ch]"
              style={{ fontSize: 17, lineHeight: 1.75, color: 'var(--color-ink-2)' }}
            >
              {ch.body}
            </p>
          </article>
        ))}
        <article
          id="run"
          className="flex flex-col items-center text-center"
          style={{ scrollMarginTop: '24px' }}
        >
          <h3
            className="font-display font-light"
            style={{
              fontVariationSettings: '"opsz" 144, "SOFT" 30, "WONK" 0',
              fontSize: 'clamp(72px, 9vw, 144px)',
              lineHeight: 0.95,
              letterSpacing: '-0.03em',
              color: 'var(--color-ink)',
            }}
          >
            Mint.
          </h3>
          <p
            className="font-body mt-6 max-w-[36ch]"
            style={{ fontSize: 18, lineHeight: 1.7, color: 'var(--color-ink-2)' }}
          >
            Mint once. Walk away. The agent persists.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4">
            <CommandPill command="bun add -g @s0nderlabs/anima" />
            <DocsLink />
          </div>
        </article>
      </div>
    </section>
  )
}

function ZeroGMark() {
  return (
    <svg
      role="img"
      aria-label="0G"
      viewBox="0 0 248 120"
      xmlns="http://www.w3.org/2000/svg"
      className="block w-auto"
      style={{ height: '0.72em' }}
      fill="currentColor"
    >
      <path d="M247.994 63.4189C246.43 94.8449 220.164 119.85 187.993 119.85C154.815 119.85 127.918 93.2547 127.918 60.4481C127.918 27.6413 154.815 1.04688 187.993 1.04688C219.144 1.04688 244.758 24.491 247.772 54.5085H220.49C217.665 39.3007 204.19 27.7779 187.994 27.7779C169.745 27.7779 154.952 42.4049 154.952 60.4481C154.952 78.4922 169.745 93.1192 187.994 93.1192C202.003 93.1192 213.974 84.498 218.782 72.3291H172.974V63.4189H247.994Z" />
      <path d="M19.7719 104.311C43.3526 125.438 79.8058 124.755 102.555 102.262C126.015 79.064 126.015 41.4537 102.555 18.2555C79.0936 -4.94194 41.0564 -4.94194 17.5956 18.2555C-4.43161 40.0359 -5.77756 74.5211 13.5575 97.8546L32.8486 78.78C23.9713 66.0513 25.2587 48.4817 36.7116 37.1576C49.6149 24.3986 70.5357 24.3986 83.4394 37.1576C96.3419 49.9163 96.3419 70.6022 83.4394 83.3611C73.5328 93.1562 58.9014 95.4318 46.7999 90.1865L79.1909 58.1583L72.8191 51.8587L19.7719 104.311Z" />
    </svg>
  )
}
