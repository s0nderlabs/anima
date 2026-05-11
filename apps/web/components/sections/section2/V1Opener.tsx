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
import { useEffect, useRef } from 'react'

const OG_BRAND = '#C026D3'

const STAGES: Record<'l1' | 'l2' | 'l3' | 'og', [number, number]> = {
  l1: [0.06, 0.2],
  l2: [0.26, 0.4],
  l3: [0.46, 0.6],
  og: [0.54, 0.68],
}

function useRevealStage(progress: MotionValue<number>, range: [number, number]) {
  const opacity = useTransform(progress, range, [0, 1])
  const y = useTransform(progress, range, [32, 0])
  const blurPx = useTransform(progress, range, [12, 0])
  const filter = useMotionTemplate`blur(${blurPx}px)`
  return { opacity, y, filter }
}

export function V1Opener() {
  const sectionRef = useRef<HTMLElement | null>(null)
  const progress = useMotionValue(0)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (reduceMotion) {
      progress.set(1)
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

  const l1 = useRevealStage(progress, STAGES.l1)
  const l2 = useRevealStage(progress, STAGES.l2)
  const l3 = useRevealStage(progress, STAGES.l3)
  const ogOp = useTransform(progress, STAGES.og, [0, 1])
  const ogScale = useTransform(progress, STAGES.og, [0.84, 1])

  const washOp = useTransform(progress, [0, 0.18, 0.85, 1], [0, 0.75, 0.75, 0.42])
  const washY = useTransform(progress, [0, 1], [80, 0])
  const washScale = useTransform(progress, [0, 1], [1.06, 1])

  return (
    <section
      ref={sectionRef}
      id="layer-opener"
      className="relative"
      style={{ height: '420vh' }}
    >
      <div className="sticky top-0 flex h-screen items-center overflow-hidden">
        <motion.div
          aria-hidden
          style={{
            opacity: washOp,
            y: washY,
            scale: washScale,
            maskImage:
              'radial-gradient(ellipse 90% 80% at 50% 110%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.75) 40%, rgba(0,0,0,0) 88%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 90% 80% at 50% 110%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.75) 40%, rgba(0,0,0,0) 88%)',
          }}
          className="pointer-events-none absolute inset-x-0 -bottom-24 h-[calc(92vh+6rem)] origin-bottom"
        >
          <Image
            src="/aurelia/grove.jpg"
            alt=""
            fill
            priority={false}
            sizes="100vw"
            className="object-cover object-bottom"
            style={{
              filter: 'blur(4px) saturate(1) contrast(0.98)',
            }}
          />
        </motion.div>

        <div className="relative z-10 mx-auto w-full max-w-[var(--container-wrap)] px-6 sm:px-8">
          <div
            className="font-display flex flex-col items-center gap-2 text-center text-[clamp(44px,6.4vw,88px)] font-light leading-[1.02] tracking-[-0.02em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
          >
            <motion.span style={l1}>No host.</motion.span>
            <motion.span style={l2}>No central operator.</motion.span>
            <motion.div
              style={l3}
              className="flex flex-wrap items-baseline justify-center gap-x-5 gap-y-3"
            >
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
        </div>
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
      className="block h-[0.72em] w-auto"
      fill={OG_BRAND}
    >
      <path d="M247.994 63.4189C246.43 94.8449 220.164 119.85 187.993 119.85C154.815 119.85 127.918 93.2547 127.918 60.4481C127.918 27.6413 154.815 1.04688 187.993 1.04688C219.144 1.04688 244.758 24.491 247.772 54.5085H220.49C217.665 39.3007 204.19 27.7779 187.994 27.7779C169.745 27.7779 154.952 42.4049 154.952 60.4481C154.952 78.4922 169.745 93.1192 187.994 93.1192C202.003 93.1192 213.974 84.498 218.782 72.3291H172.974V63.4189H247.994Z" />
      <path d="M19.7719 104.311C43.3526 125.438 79.8058 124.755 102.555 102.262C126.015 79.064 126.015 41.4537 102.555 18.2555C79.0936 -4.94194 41.0564 -4.94194 17.5956 18.2555C-4.43161 40.0359 -5.77756 74.5211 13.5575 97.8546L32.8486 78.78C23.9713 66.0513 25.2587 48.4817 36.7116 37.1576C49.6149 24.3986 70.5357 24.3986 83.4394 37.1576C96.3419 49.9163 96.3419 70.6022 83.4394 83.3611C73.5328 93.1562 58.9014 95.4318 46.7999 90.1865L79.1909 58.1583L72.8191 51.8587L19.7719 104.311Z" />
    </svg>
  )
}
