'use client'

import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import type { Cycle, ToolStreamEntry } from '@/lib/cycles'

type Stage = 'idle' | 'typing' | 'committed' | 'tools' | 'reply'

// Animation budget per cycle (~12s total). Each phase below is wall-clock
// from the start of the cycle. Paced for readability and synced to the
// right-side voyage stations in lib/provenance.ts:
//   0    - 400ms     idle (cursor in empty input, sys line + nothing else)
//   400  - 2600ms    typing (prompt fills the input bar, char-by-char)
//   2600 - 2800ms    commit (input clears, prompt lands as `you · …`)
//                    → right station 1 fires at 2700 (you signed)
//                    → right station 2 fires at 3000 (brain attested)
//   2800 - +N*700ms  tools stream in beneath `anima` label as ● + └ ok
//                    → right station 3 fires at 3400 (sandbox engaged)
//                    → right station 4 fires at 6500 (memory.save)
//   ~7600ms          reply text fades in below the tool block
//   ~9000ms          → right station 5 fires (chain anchor flush)
//   ~12000ms         hold, cycle swaps
const IDLE_MS = 400
const TYPING_MS = 2200
const COMMIT_MS = 200
const TOOL_STAGGER_MS = 700
const REPLY_DELAY_MS = 600

// Real anima TUI label colors. Light-mode-ish but still recognizable.
const COLOR_SYS = 'rgba(26, 20, 16, 0.40)'
const COLOR_YOU = '#2a78a8'
const COLOR_ANIMA = '#3a8e5e'
const COLOR_THINKING = '#2a78a8'

export function TuiCanvas({ cycle }: { cycle: Cycle }) {
  const [stage, setStage] = useState<Stage>('idle')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setStage('idle')
    const tTyping = setTimeout(() => setStage('typing'), IDLE_MS)
    const tCommitted = setTimeout(() => setStage('committed'), IDLE_MS + TYPING_MS)
    const tTools = setTimeout(() => setStage('tools'), IDLE_MS + TYPING_MS + COMMIT_MS)
    const replyAt =
      IDLE_MS +
      TYPING_MS +
      COMMIT_MS +
      cycle.toolStream.length * TOOL_STAGGER_MS +
      REPLY_DELAY_MS
    const tReply = setTimeout(() => setStage('reply'), replyAt)
    return () => {
      clearTimeout(tTyping)
      clearTimeout(tCommitted)
      clearTimeout(tTools)
      clearTimeout(tReply)
    }
  }, [cycle.id, cycle.toolStream.length])

  // Auto-scroll the scrollback to the bottom as new content lands.
  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [stage])

  const showUserPrompt =
    stage === 'committed' || stage === 'tools' || stage === 'reply'
  const showAnimaRow = stage === 'tools' || stage === 'reply'
  const showTools = stage === 'tools' || stage === 'reply'
  const showReply = stage === 'reply'
  const showThinking = stage === 'committed' || stage === 'tools'

  return (
    <div className="flex h-full min-h-[460px] flex-col bg-[var(--color-paper)] font-mono text-[12px] leading-[1.55] text-[var(--color-ink)]">
      {/* SCROLLBACK , every line uses a 60px label column on the left
          (sys/you/anima) + content on the right. Matches real anima TUI.
          `min-h-0` forces the flex child to honor its share instead of
          growing to intrinsic content height, so long replies scroll
          internally instead of pushing the status line off-frame. */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* sys line , always visible at top */}
        <Row label="sys" labelColor={COLOR_SYS}>
          <span style={{ color: COLOR_SYS }}>
            connected to anima.0g · 0G mainnet
          </span>
        </Row>

        {/* user prompt */}
        {showUserPrompt && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
            className="mt-3"
          >
            <Row label="you" labelColor={COLOR_YOU}>
              <span style={{ whiteSpace: 'pre-wrap' }}>{cycle.prompt}</span>
            </Row>
          </motion.div>
        )}

        {/* anima row , tools then reply share a single content column */}
        {showAnimaRow && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
            className="mt-3"
          >
            <Row label="anima" labelColor={COLOR_ANIMA}>
              <div className="flex flex-col">
                {showTools &&
                  cycle.toolStream.map((entry, idx) => (
                    <ToolBlock
                      key={`${cycle.id}-${entry.tool}-${idx}`}
                      entry={entry}
                      delaySec={(idx * TOOL_STAGGER_MS) / 1000}
                    />
                  ))}
                {showReply && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.32 }}
                    className="mt-3 font-body text-[12.5px] leading-[1.5]"
                    style={{ whiteSpace: 'pre-wrap' }}
                    dangerouslySetInnerHTML={{
                      __html: cycle.reply.replace(
                        /\*\*(.*?)\*\*/g,
                        '<strong style="font-weight:600">$1</strong>',
                      ),
                    }}
                  />
                )}
              </div>
            </Row>
          </motion.div>
        )}
      </div>

      {/* THINKING ROW , appears between scrollback + input while the brain
          is working. Disappears once the reply lands. */}
      {showThinking && <ThinkingRow stage={stage} />}

      {/* INPUT BAR , `>` + typed chars + inline block cursor.
          Cursor must be inline (not a flex sibling) so when the prompt wraps
          to a second line, the cursor sits after the last typed character
          on the current line instead of floating to the right edge of the
          multi-line flex row.
          `shrink-0` locks input + status to the bottom of the canvas frame
          even when the scrollback fills , they never get squeezed off. */}
      <div
        className="shrink-0 border-t border-[var(--color-border)] px-4 py-2.5"
        style={{ background: 'rgba(26, 20, 16, 0.05)' }}
      >
        <div className="flex items-center gap-1.5">
          <span style={{ color: COLOR_THINKING }}>{'>'}</span>
          <span className="min-w-0 flex-1" style={{ wordBreak: 'break-word' }}>
            {stage === 'typing' ? (
              <TypingChars text={cycle.prompt} durationMs={TYPING_MS} />
            ) : null}
            <span
              aria-hidden
              className="inline-block align-text-bottom bg-[var(--color-ink)]"
              style={{ width: 7, height: 13, marginLeft: 1 }}
            />
          </span>
        </div>
      </div>

      {/* STATUS LINE , agent identity + key meta */}
      <div className="flex shrink-0 items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-paper)] px-4 py-1.5 text-[10px] tracking-[0.04em]">
        <span className="flex items-center gap-2">
          <span style={{ color: COLOR_ANIMA, fontWeight: 500 }}>anima.0g</span>
          <span style={{ color: 'var(--color-ink-3)', opacity: 0.5 }}>·</span>
          <span style={{ color: 'var(--color-ink-3)' }}>0xC635…87Ec</span>
          <span style={{ color: 'var(--color-ink-3)', opacity: 0.5 }}>·</span>
          <span style={{ color: 'var(--color-ink-3)' }}>compute 0.91 0G</span>
        </span>
        <span style={{ color: '#c4793a' }}>perms: off</span>
      </div>
    </div>
  )
}

// ─────────── Row layout ───────────

function Row({
  label,
  labelColor,
  children,
}: {
  label: string
  labelColor: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[60px_1fr] items-start gap-2">
      <span
        style={{ color: labelColor, fontWeight: 500 }}
        className="pt-[1px] tracking-tight"
      >
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

// ─────────── tool block (●tool(args) + └ ok) ───────────

function ToolBlock({ entry, delaySec }: { entry: ToolStreamEntry; delaySec: number }) {
  const ok = entry.status === 'ok'
  return (
    <motion.div
      initial={{ opacity: 0, x: -3 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, delay: delaySec }}
      className="mt-1.5 first:mt-0"
    >
      <div className="flex items-baseline gap-1.5">
        <span style={{ color: 'var(--color-ink)' }}>●</span>
        <span style={{ color: 'var(--color-ink)' }}>{entry.tool}</span>
        {entry.args && (
          <span style={{ color: 'var(--color-ink-3)' }}>({entry.args})</span>
        )}
      </div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18, delay: delaySec + 0.12 }}
        className="pl-[14px]"
        style={{ color: 'var(--color-ink-3)' }}
      >
        └ <span style={{ color: ok ? COLOR_ANIMA : '#c4393a' }}>{entry.status}</span>
      </motion.div>
    </motion.div>
  )
}

// ─────────── thinking spinner ───────────

function ThinkingRow({ stage }: { stage: Stage }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    setSeconds(0)
    const id = setInterval(() => setSeconds(s => s + 1), 1000)
    return () => clearInterval(id)
  }, [stage])

  return (
    <div className="shrink-0 px-4 py-1.5">
      <div className="flex items-center gap-2">
        <Spinner />
        <span className="text-[12px]" style={{ color: COLOR_THINKING }}>
          thinking… {seconds}s (esc to interrupt)
        </span>
      </div>
    </div>
  )
}

// Same 10-frame braille spinner the real anima TUI uses
// (packages/cli/src/ui/app.tsx:8). 80ms cadence per frame.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

function Spinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length)
    }, 80)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="font-mono text-[12px]" style={{ color: COLOR_THINKING }}>
      {SPINNER_FRAMES[frame]}
    </span>
  )
}

// ─────────── typing animation ───────────

function TypingChars({ text, durationMs }: { text: string; durationMs: number }) {
  const [shown, setShown] = useState('')
  useEffect(() => {
    setShown('')
    const start = performance.now()
    let raf = 0
    const tick = () => {
      const elapsed = performance.now() - start
      const progress = Math.min(1, elapsed / durationMs)
      const idx = Math.floor(progress * text.length)
      setShown(text.slice(0, idx))
      if (progress < 1) raf = requestAnimationFrame(tick)
      else setShown(text)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, durationMs])
  return <span>{shown}</span>
}
