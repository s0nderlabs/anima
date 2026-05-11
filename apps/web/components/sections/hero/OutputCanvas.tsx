'use client'

import type { Cycle } from '@/lib/cycles'
import { type GlyphKind, PROVENANCE, type Receipt } from '@/lib/provenance'
import { AnimatePresence, motion } from 'framer-motion'
import { Fragment, useEffect, useRef, useState } from 'react'

type Props = { cycle: Cycle }

/**
 * Right-side hero canvas. The agent's voyage through 0G , the prompt
 * descends through five stations (your wallet, the TEE brain, the
 * sandbox, 0G Storage, 0G Chain). A continuous ink line runs the full
 * height; the path "fills in" downward to the active station's node as
 * each one fires. Empty stations don't render , only the line.
 *
 * Each node holds a tool-specific animated glyph: a signature drawing
 * itself, a TEE seal pulsing, a browser cursor traversing, a padlock
 * shackle clicking shut, an anchor descending. The icon ANIMATES at
 * the moment the substrate fires.
 */
export function OutputCanvas({ cycle }: Props) {
  const provenance = PROVENANCE[cycle.id] ?? null

  return (
    <div className="relative h-full min-h-[460px] overflow-hidden bg-[var(--color-cream-warm)]">
      <PaintingTint painting={cycle.painting} />

      <AnimatePresence mode="wait">
        <motion.div
          key={cycle.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 1.0, ease: [0.22, 1, 0.36, 1] }}
          className="relative flex h-full flex-col px-6 pt-6 pb-6 sm:px-9 sm:pt-7"
        >
          <Header cycle={cycle} intro={provenance?.intro} />

          <div className="relative mt-4 flex-1">
            {provenance ? (
              <Voyage key={cycle.id} receipts={provenance.receipts} outcome={provenance.outcome} />
            ) : null}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

// ─── Header ────────────────────────────────────────────────────────────

function Header({ cycle, intro }: { cycle: Cycle; intro?: string }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const cycleTitle = cycle.id.charAt(0).toUpperCase() + cycle.id.slice(1)
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="font-italic text-[24px] italic leading-none text-[var(--color-ink)]">
          behind the chat
        </div>
        {intro ? (
          <div className="font-body mt-2 whitespace-nowrap text-[12px] leading-snug text-[var(--color-ink-2)]">
            {intro}
          </div>
        ) : null}
      </div>
      <div className="font-mono shrink-0 text-right text-[10px] tracking-[0.06em] text-[var(--color-ink-3)]">
        <div>{cycleTitle}</div>
        <div className="mt-0.5 text-[var(--color-ink-2)]">
          14:32:{String(18 + tick).padStart(2, '0')}
        </div>
      </div>
    </div>
  )
}

// ─── Voyage (the journey) ─────────────────────────────────────────────

const NODE_COL_PX = 22 // width of node column (small dot)
const NODE_CENTER_PX = 11 // center X of the dot within the column
const DOT_SIZE_PX = 9 // diameter of the simple ink dot
// Push the dot down within its column so its center vertically aligns
// with the first line of the narration (the visually dominant text)
// instead of with the small layer label above it. The line also starts
// at this offset so it anchors at the first dot's center, not at the
// top of the panel.
const DOT_TOP_OFFSET_PX = 28
const LINE_START_PX = DOT_TOP_OFFSET_PX + DOT_SIZE_PX / 2
const GLYPH_COL_PX = 56 // right-side column for the big animated glyph
const STATION_GAP = 28 // vertical gap between station rows

function Voyage({
  receipts,
  outcome,
}: {
  receipts: Receipt[]
  outcome: string
}) {
  const [activeIdx, setActiveIdx] = useState(-1)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const nodeRefs = useRef<(HTMLDivElement | null)[]>([])
  const [drawnHeight, setDrawnHeight] = useState(0)

  // Activate stations in sequence.
  useEffect(() => {
    setActiveIdx(-1)
    const timeouts = receipts.map((r, i) =>
      setTimeout(() => setActiveIdx(prev => Math.max(prev, i)), r.delayMs),
    )
    return () => timeouts.forEach(clearTimeout)
  }, [receipts])

  // Measure container + node positions to drive the continuous line.
  // Line starts at the FIRST dot's center (LINE_START_PX from container
  // top), not at the very top of the panel, because the dots are pushed
  // down to align with their narration text. drawnHeight is therefore the
  // distance from the first dot's center to the active dot's center.
  useEffect(() => {
    function measure() {
      const c = containerRef.current
      if (!c) return
      if (activeIdx < 0) {
        setDrawnHeight(0)
        return
      }
      const node = nodeRefs.current[activeIdx]
      if (!node) return
      const nodeRect = node.getBoundingClientRect()
      const containerRect = c.getBoundingClientRect()
      const center = nodeRect.top + nodeRect.height / 2 - containerRect.top
      setDrawnHeight(Math.max(0, center - LINE_START_PX))
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [activeIdx, receipts])

  const allDone = activeIdx >= receipts.length - 1

  return (
    <div ref={containerRef} className="relative">
      {/* CONTINUOUS LINE , anchored to the first dot's center, drawing
          downward to the active node's center as stations fire. */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute"
        style={{
          top: LINE_START_PX,
          left: NODE_CENTER_PX - 0.75,
          width: 1.5,
          background: 'var(--color-ink)',
        }}
        initial={{ height: 0 }}
        animate={{ height: drawnHeight }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      />

      <ol className="relative flex flex-col" style={{ gap: STATION_GAP }}>
        {receipts.map((r, i) => (
          <Fragment key={r.id}>
            <Station
              receipt={r}
              visible={i <= activeIdx}
              isCurrent={i === activeIdx}
              nodeRef={el => {
                nodeRefs.current[i] = el
              }}
            />
          </Fragment>
        ))}
      </ol>

      {/* outcome , only after every station has landed */}
      <AnimatePresence>
        {allDone ? (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
            className="mt-7 pl-[34px]"
          >
            <div className="mb-3 h-px w-10 bg-[var(--color-ink-3)] opacity-50" />
            <div className="font-body text-[14.5px] font-medium leading-snug text-[var(--color-ink)]">
              {outcome}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function Station({
  receipt,
  visible,
  isCurrent,
  nodeRef,
}: {
  receipt: Receipt
  visible: boolean
  isCurrent: boolean
  nodeRef: (el: HTMLDivElement | null) => void
}) {
  return (
    <li
      className="grid items-start gap-4"
      style={{
        gridTemplateColumns: `${NODE_COL_PX}px 1fr ${GLYPH_COL_PX}px`,
      }}
    >
      {/* node column , small simple ink dot, pushed down via paddingTop
          so its center aligns with the narration's first line (not the
          small layer label above it). */}
      <div className="relative flex justify-center" style={{ paddingTop: DOT_TOP_OFFSET_PX }}>
        <div ref={nodeRef} style={{ width: DOT_SIZE_PX, height: DOT_SIZE_PX }}>
          <NodeDot visible={visible} isCurrent={isCurrent} />
        </div>
      </div>
      <Annotation receipt={receipt} visible={visible} />
      <RightGlyph kind={receipt.glyph} visible={visible} isCurrent={isCurrent} />
    </li>
  )
}

// ─── Node dot (simple, minimalist) ────────────────────────────────────

function NodeDot({
  visible,
  isCurrent,
}: {
  visible: boolean
  isCurrent: boolean
}) {
  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: [0.95, 1.4, 1], opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1.6, 0.36, 1] }}
          className="relative h-full w-full rounded-full"
          style={{ background: 'var(--color-ink)' }}
        >
          {isCurrent ? (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{ background: 'var(--color-ink)' }}
              animate={{ opacity: [0.5, 0, 0.5], scale: [1, 2.4, 1] }}
              transition={{
                duration: 2.4,
                repeat: Number.POSITIVE_INFINITY,
                ease: 'easeOut',
              }}
            />
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

// ─── Right-side animated glyph column ────────────────────────────────

function RightGlyph({
  kind,
  visible,
  isCurrent,
}: {
  kind: GlyphKind
  visible: boolean
  isCurrent: boolean
}) {
  return (
    <div className="flex h-9 items-center justify-end">
      <AnimatePresence>
        {visible ? (
          <motion.div
            initial={{ scale: 0.5, opacity: 0, rotate: -8 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{
              duration: 0.6,
              ease: [0.22, 1.4, 0.36, 1],
              delay: 0.1,
            }}
            className="origin-right"
          >
            <BigGlyph kind={kind} active={isCurrent} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

// ─── Annotation (label + readable narration + proof) ─────────────────

function Annotation({ receipt, visible }: { receipt: Receipt; visible: boolean }) {
  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.25 }}
          className="min-w-0 pt-[1px]"
        >
          {/* layer label */}
          <div className="font-mono text-[10.5px] tracking-[0.06em] text-[var(--color-ink-2)]">
            {receipt.layer}
          </div>
          {/* narration carries the meaning */}
          <p className="font-body mt-1 text-[14px] leading-[1.5] text-[var(--color-ink)]">
            {receipt.narration}
          </p>
          {/* Only render verify link when there's a real on-chain artifact.
              Algorithm names + hex chunks are noise for general readers; the
              narration above already carries the meaning. See
              feedback-voyage-proof-lines-quiet.md. */}
          {receipt.proofHref ? (
            <a
              href={receipt.proofHref}
              target="_blank"
              rel="noreferrer"
              className="font-mono mt-2 inline-block text-[10.5px] text-[var(--color-ink-3)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
            >
              verify on chain ↗
            </a>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

// ─── Painting tint ────────────────────────────────────────────────────

function PaintingTint({ painting }: { painting: Cycle['painting'] }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `url(/aurelia/${painting}.png)`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        opacity: 0.22,
        filter: 'blur(40px) saturate(0.85)',
        mixBlendMode: 'multiply',
      }}
    />
  )
}

// ─── Tool-specific animated glyphs ────────────────────────────────────

function BigGlyph({ kind, active }: { kind: GlyphKind; active: boolean }) {
  switch (kind) {
    case 'sign':
      return <SignGlyph />
    case 'brain':
      return <BrainGlyph active={active} />
    case 'browser':
      return <BrowserGlyph active={active} />
    case 'lock':
      return <LockGlyph />
    case 'anchor':
      return <AnchorGlyph />
    case 'swap':
      return <SwapGlyph active={active} />
    case 'stake':
      return <StakeGlyph />
    case 'message':
      return <MessageGlyph />
    case 'gavel':
      return <GavelGlyph />
  }
}

const GLYPH_SIZE = 42 // px , big right-column animated glyph

const G_STROKE = 'var(--color-ink)'

function SignGlyph() {
  // A real-feeling signature: variable amplitude (not even sine-wave bumps),
  // a tall initial loop like a capital cursive letter, a smaller second
  // letter, a low dip + recover (mid-name ligature), then a tail flourish
  // that lifts off the page. A separate "i-tittle" dot drops in above,
  // and a faint signature line draws beneath at the end.
  //
  // Anatomy of the main path:
  //   M 3 14              start at the baseline left edge
  //   C 5 6 8 6 8 14      tall first arch (peaks at y=6) , the capital
  //   C 8 10 11 10 11 14  smaller second arch (peaks at y=10)
  //   S 14 17 16 13       smooth cubic dipping below baseline then up
  //   Q 19 9 21 7         quadratic flourish curling up-right off the page
  //
  // The overall feel is "tall · short · dip · flourish" , the way many
  // handwritten signatures actually move.
  return (
    <svg viewBox="0 0 24 24" width={GLYPH_SIZE} height={GLYPH_SIZE} className="relative z-10">
      {/* Main signature gesture , one continuous stroke */}
      <motion.path
        d="M 3 14 C 5 6 8 6 8 14 C 8 10 11 10 11 14 S 14 17 16 13 Q 19 9 21 7"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.5, ease: [0.4, 0, 0.2, 1], delay: 0.15 }}
      />
      {/* i-tittle dot , drops in above the second arch like dotting
          an i mid-name */}
      <motion.circle
        cx="11"
        cy="6"
        r="0.75"
        fill={G_STROKE}
        initial={{ y: -3, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{
          duration: 0.35,
          ease: [0.4, 1.6, 0.4, 1],
          delay: 1.55,
        }}
      />
      {/* Faint signature line drawn beneath at the end */}
      <motion.line
        x1="3"
        y1="20"
        x2="20"
        y2="20"
        stroke={G_STROKE}
        strokeWidth="0.85"
        strokeLinecap="round"
        opacity="0.5"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.65, ease: 'easeOut', delay: 1.8 }}
      />
    </svg>
  )
}

function BrainGlyph({ active }: { active: boolean }) {
  // Anatomical brain icon. Drops the previous hexagon shield (it was
  // squeezing the inside until nothing read as a brain) and lets the
  // brain occupy the full viewBox. Anatomy:
  //   1. Outer two-lobed silhouette , oval body with a shallow notch
  //      at the top center where the hemispheres meet, drawn as a
  //      single closed cubic Bezier path
  //   2. Longitudinal fissure , vertical center line dividing the lobes
  //   3. Cortical folds , 4 small S-curves (2 per hemisphere) suggesting
  //      the brain's signature gyri/sulci pattern
  //   4. Brainstem hint , a small stub poking down from the bottom center
  // When this is the active station, the entire brain matter (fissure +
  // folds) pulses opacity in a slow 2.4s rhythm , visualising thought.
  // The TEE-enclave context now lives in the narration ("Reasoning ran
  // inside a TEE..."), so the glyph can stay focused on cognition.
  return (
    <svg viewBox="0 0 24 24" width={GLYPH_SIZE} height={GLYPH_SIZE} className="relative z-10">
      {/* OUTER BRAIN SILHOUETTE
          Path traces the outline clockwise from top-center: dips down for
          the notch between hemispheres, sweeps over the left lobe, down
          the left side, around the bottom, up the right side, over the
          right lobe, and closes back at the top notch. The Bezier control
          points are tuned for a brain-like "two-bump" top + rounded body. */}
      <motion.path
        d="M 12 5
           C 10 3 6 4 4 7
           C 2.5 9.5 2.5 13 4 16
           C 6 19 9 20 12 19
           C 15 20 18 19 20 16
           C 21.5 13 21.5 9.5 20 7
           C 18 4 14 3 12 5
           Z"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.1, ease: [0.4, 0, 0.2, 1], delay: 0.2 }}
      />

      {/* INNER BRAIN MATTER , fissure + cortical folds + brainstem,
          wrapped in a g that pulses opacity when this station is active */}
      <motion.g
        animate={active ? { opacity: [0.65, 1, 0.65] } : { opacity: 1 }}
        transition={{
          duration: active ? 2.4 : 0.4,
          repeat: active ? Number.POSITIVE_INFINITY : 0,
          ease: 'easeInOut',
          delay: 1.7,
        }}
      >
        {/* Longitudinal fissure (the deep groove dividing the hemispheres) */}
        <motion.line
          x1="12"
          y1="5"
          x2="12"
          y2="19"
          stroke={G_STROKE}
          strokeWidth="1"
          strokeLinecap="round"
          opacity="0.75"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.65, ease: 'easeOut', delay: 1.25 }}
        />

        {/* LEFT HEMISPHERE FOLDS , two horizontal-ish S-curves
            suggesting the brain's gyri */}
        <motion.path
          d="M 5 9 Q 6.5 8.2 7.2 10 Q 7.8 11.6 9.6 10.8"
          fill="none"
          stroke={G_STROKE}
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.85"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.55, delay: 1.45 }}
        />
        <motion.path
          d="M 4.5 13 Q 6.2 12.4 7 14.2 Q 7.7 16 9.6 15.2"
          fill="none"
          stroke={G_STROKE}
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.85"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.55, delay: 1.6 }}
        />

        {/* RIGHT HEMISPHERE FOLDS , mirror */}
        <motion.path
          d="M 19 9 Q 17.5 8.2 16.8 10 Q 16.2 11.6 14.4 10.8"
          fill="none"
          stroke={G_STROKE}
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.85"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.55, delay: 1.5 }}
        />
        <motion.path
          d="M 19.5 13 Q 17.8 12.4 17 14.2 Q 16.3 16 14.4 15.2"
          fill="none"
          stroke={G_STROKE}
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.85"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.55, delay: 1.65 }}
        />

        {/* Brainstem , a tiny stub poking down from bottom center */}
        <motion.path
          d="M 11.2 19.4 Q 12 21 12.8 19.4"
          fill="none"
          stroke={G_STROKE}
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.7"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut', delay: 1.85 }}
        />
      </motion.g>
    </svg>
  )
}

function BrowserGlyph({ active }: { active: boolean }) {
  // browser window with a dot/cursor traversing the address bar
  return (
    <svg viewBox="0 0 24 24" width={GLYPH_SIZE} height={GLYPH_SIZE} className="relative z-10">
      <motion.rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="1.4"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1], delay: 0.15 }}
      />
      <motion.line
        x1="3"
        y1="9"
        x2="21"
        y2="9"
        stroke={G_STROKE}
        strokeWidth="1"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut', delay: 0.7 }}
      />
      {/* traffic-light dots */}
      <motion.circle
        cx="5.5"
        cy="7"
        r="0.8"
        fill={G_STROKE}
        opacity="0.6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.6 }}
        transition={{ delay: 0.95 }}
      />
      <motion.circle
        cx="8"
        cy="7"
        r="0.8"
        fill={G_STROKE}
        opacity="0.4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.4 }}
        transition={{ delay: 1.05 }}
      />
      {/* cursor traversing the address bar */}
      <motion.circle
        cy="13"
        r="1.6"
        fill={G_STROKE}
        initial={{ cx: 5, opacity: 0 }}
        animate={active ? { cx: [5, 19, 5], opacity: [0, 1, 1, 1, 0] } : { cx: 19, opacity: 1 }}
        transition={{
          duration: active ? 3.2 : 0.6,
          repeat: active ? Number.POSITIVE_INFINITY : 0,
          repeatType: 'loop',
          ease: 'easeInOut',
          delay: 1.0,
        }}
      />
    </svg>
  )
}

function LockGlyph() {
  // padlock body + shackle that closes (rotates from open to shut)
  return (
    <svg viewBox="0 0 24 24" width={GLYPH_SIZE} height={GLYPH_SIZE} className="relative z-10">
      {/* lock body */}
      <motion.rect
        x="5"
        y="11"
        width="14"
        height="10"
        rx="1.2"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1], delay: 0.3 }}
      />
      {/* shackle , animates from "open" (offset) to "shut" (centered) */}
      <motion.path
        d="M 8 11 V 8 a 4 3 0 0 1 8 0 V 11"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        strokeLinecap="round"
        initial={{ y: -3, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.4, 1.5, 0.4, 1], delay: 0.95 }}
      />
      {/* keyhole */}
      <motion.circle
        cx="12"
        cy="15.5"
        r="1.1"
        fill={G_STROKE}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5, duration: 0.4 }}
      />
      <motion.line
        x1="12"
        y1="16.5"
        x2="12"
        y2="18.5"
        stroke={G_STROKE}
        strokeWidth="1.2"
        strokeLinecap="round"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5, duration: 0.4 }}
      />
    </svg>
  )
}

function AnchorGlyph() {
  // Nautical anchor , the storage root anchored into the iNFT. Anatomy:
  //   1. Shackle (ring at top, where rope/chain attaches)
  //   2. Shank (vertical shaft connecting ring to crown)
  //   3. Stock (horizontal crossbar near the top)
  //   4. Crown + arms (curved U at the bottom)
  //   5. Flukes (barbed points at the ends of each arm)
  // The whole anchor drops in from above (y motion on the wrapping g)
  // while strokes draw in sequence , it lands like a real anchor finding
  // the seabed.
  return (
    <svg viewBox="0 0 24 24" width={GLYPH_SIZE} height={GLYPH_SIZE} className="relative z-10">
      <motion.g
        initial={{ y: -3, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.4, 1.2, 0.4, 1], delay: 0.15 }}
      >
        {/* shackle , ring at the top */}
        <motion.circle
          cx="12"
          cy="4"
          r="1.7"
          fill="none"
          stroke={G_STROKE}
          strokeWidth="1.3"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.45, ease: 'easeOut', delay: 0.3 }}
        />
        {/* shank , the vertical shaft */}
        <motion.line
          x1="12"
          y1="5.7"
          x2="12"
          y2="17.5"
          stroke={G_STROKE}
          strokeWidth="1.4"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.65, ease: 'easeOut', delay: 0.55 }}
        />
        {/* stock , the horizontal crossbar near the top, a touch
            shorter on the right than the left for that worn nautical
            asymmetry */}
        <motion.line
          x1="7.8"
          y1="8"
          x2="16.4"
          y2="8"
          stroke={G_STROKE}
          strokeWidth="1.3"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.45, ease: 'easeOut', delay: 0.85 }}
        />
        {/* crown + arms , the U-curve at the bottom */}
        <motion.path
          d="M 6 13.5 Q 6 19 12 19 Q 18 19 18 13.5"
          fill="none"
          stroke={G_STROKE}
          strokeWidth="1.4"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1], delay: 1.05 }}
        />
        {/* left fluke , a small barbed triangle hint at the arm end */}
        <motion.path
          d="M 6 13.5 L 4.3 12.5 M 6 13.5 L 5 15.6"
          fill="none"
          stroke={G_STROKE}
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.35, ease: 'easeOut', delay: 1.65 }}
        />
        {/* right fluke , mirror */}
        <motion.path
          d="M 18 13.5 L 19.7 12.5 M 18 13.5 L 19 15.6"
          fill="none"
          stroke={G_STROKE}
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.35, ease: 'easeOut', delay: 1.65 }}
        />
      </motion.g>
    </svg>
  )
}

// extra glyphs for other cycles (swap, stake, message, gavel) , minimal

function SwapGlyph({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={GLYPH_SIZE} height={GLYPH_SIZE} className="relative z-10">
      <motion.path
        d="M 5 8 H 17 L 14 5"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.7, delay: 0.3 }}
      />
      <motion.path
        d="M 19 16 H 7 L 10 19"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.7, delay: 0.8 }}
      />
      {active ? (
        <motion.circle
          cx="12"
          cy="12"
          r="1.4"
          fill={G_STROKE}
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY }}
        />
      ) : null}
    </svg>
  )
}

function StakeGlyph() {
  // A coin balanced on a pillar that gets locked into place , the metaphor
  // of staking: value placed on a substrate, held there by a contractual
  // bar that "clicks shut" at the end. Drawing order:
  //   1. base/ground line (the foundation)
  //   2. pillar rises from the base
  //   3. coin lands on top
  //   4. lock crossbar slides in from outside the frame and snaps shut
  // The crossbar landing is the "stake locked" beat.
  return (
    <svg viewBox="0 0 24 24" width={GLYPH_SIZE} height={GLYPH_SIZE} className="relative z-10">
      {/* base / ground line */}
      <motion.line
        x1="5"
        y1="20"
        x2="19"
        y2="20"
        stroke={G_STROKE}
        strokeWidth="1.2"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1], delay: 0.2 }}
      />
      {/* pillar , a vertical column rising up from the base */}
      <motion.rect
        x="9.5"
        y="10"
        width="5"
        height="10"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1], delay: 0.55 }}
      />
      {/* inner column lines suggesting depth + capital flutes */}
      <motion.line
        x1="11"
        y1="11.5"
        x2="11"
        y2="19"
        stroke={G_STROKE}
        strokeWidth="0.7"
        strokeLinecap="round"
        opacity="0.45"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut', delay: 1.0 }}
      />
      <motion.line
        x1="13"
        y1="11.5"
        x2="13"
        y2="19"
        stroke={G_STROKE}
        strokeWidth="0.7"
        strokeLinecap="round"
        opacity="0.45"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut', delay: 1.0 }}
      />
      {/* coin balanced on top , drops in from above */}
      <motion.circle
        cx="12"
        cy="6.5"
        r="2.6"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        initial={{ y: -10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{
          duration: 0.5,
          ease: [0.4, 1.4, 0.4, 1],
          delay: 1.2,
        }}
      />
      {/* coin tick (a tiny dot suggesting denomination) */}
      <motion.circle
        cx="12"
        cy="6.5"
        r="0.55"
        fill={G_STROKE}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 1.6 }}
      />
      {/* lock crossbar , slides in from the left, snaps over the
          pillar's top edge (this is the "locked" beat) */}
      <motion.line
        x1="7"
        y1="10"
        x2="17"
        y2="10"
        stroke={G_STROKE}
        strokeWidth="1.4"
        strokeLinecap="round"
        initial={{ pathLength: 0, x: -10 }}
        animate={{ pathLength: 1, x: 0 }}
        transition={{
          duration: 0.45,
          ease: [0.4, 1.6, 0.4, 1],
          delay: 1.7,
        }}
      />
    </svg>
  )
}

function MessageGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={GLYPH_SIZE} height={GLYPH_SIZE} className="relative z-10">
      <motion.rect
        x="3"
        y="6"
        width="18"
        height="12"
        rx="1.2"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.9 }}
      />
      <motion.path
        d="M 3 7 L 12 14 L 21 7"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.2"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.7, delay: 0.5 }}
      />
    </svg>
  )
}

function GavelGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={GLYPH_SIZE} height={GLYPH_SIZE} className="relative z-10">
      <motion.path
        d="M 8 4 L 15 11 L 12 14 L 5 7 Z"
        fill="none"
        stroke={G_STROKE}
        strokeWidth="1.4"
        strokeLinejoin="round"
        initial={{ pathLength: 0, rotate: -30, originX: 0.5, originY: 0.5 }}
        animate={{ pathLength: 1, rotate: 0 }}
        transition={{ duration: 0.9 }}
      />
      <motion.line
        x1="4"
        y1="20"
        x2="20"
        y2="20"
        stroke={G_STROKE}
        strokeWidth="1.4"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, delay: 0.7 }}
      />
    </svg>
  )
}
