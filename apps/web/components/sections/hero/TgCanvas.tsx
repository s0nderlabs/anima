'use client'

import { motion } from 'framer-motion'
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import type { Cycle, ToolStreamEntry } from '@/lib/cycles'

type Stage =
  | 'idle'
  | 'greeting-user'
  | 'greeting-think'
  | 'greeting-reply'
  | 'main-user'
  | 'main-think'
  | 'main-tools'
  | 'main-reply'

const SF_STACK =
  '-apple-system, "SF Pro Text", "SF Pro", system-ui, "Segoe UI", Roboto, sans-serif'

// Subset of `packages/plugin-telegram/src/progress.ts:29` , the tool→emoji
// map that real anima TG uses. Anything not listed defaults to 🔧.
const TOOL_EMOJI: Record<string, string> = {
  'shell.run': '💻',
  'shell.cd': '📁',
  'fs.read': '📄',
  'fs.write': '✏️',
  'fs.search': '🔍',
  'web.fetch': '🌐',
  'browser.navigate': '🌐',
  'browser.snapshot': '📸',
  'browser.click': '🖱️',
  'browser.type': '⌨️',
  'memory.read': '🧠',
  'memory.save': '💾',
  'session.search': '🔎',
  'code.execute': '🐍',
  'tool.search': '🔧',
  'chain.gas': '⛽',
  'chain.balance': '💰',
  'chain.contract': '📜',
  'chain.tx': '📝',
  'wallet.transfer': '💸',
  'swap.quote': '🔁',
  'swap.execute': '🔄',
  'stake.delegate': '🥩',
  'stake.stake': '🥩',
  'stake.position': '🥩',
  'agent.message': '📨',
  'agent.history': '📜',
  'market.list': '🛒',
  'market.createJob': '🛒',
  'market.bid': '🪙',
  'market.acceptResult': '✅',
  'account.info': 'ℹ️',
  'account.balance': '💰',
}

// Stage timeline (in ms from cycle start). Tuned for ~9.5s total cycle.
const T_GREETING_USER = 200
const T_GREETING_THINK = 800
const T_GREETING_REPLY = 1500
const T_MAIN_USER = 2400
const T_MAIN_THINK = 3000
const T_MAIN_TOOLS = 3800
const TOOL_LINE_STAGGER_MS = 380
const TOOL_END_LAG_MS = 240
const REPLY_GAP_MS = 380
const REPLY_FADE_MS = 380

export function TgCanvas({ cycle }: { cycle: Cycle }) {
  const hasGreeting = !!cycle.greeting
  const [stage, setStage] = useState<Stage>('idle')

  useEffect(() => {
    setStage('idle')
    const timers: ReturnType<typeof setTimeout>[] = []
    const sched = (at: number, s: Stage) => {
      timers.push(setTimeout(() => setStage(s), at))
    }

    if (hasGreeting) {
      sched(T_GREETING_USER, 'greeting-user')
      sched(T_GREETING_THINK, 'greeting-think')
      sched(T_GREETING_REPLY, 'greeting-reply')
      sched(T_MAIN_USER, 'main-user')
      sched(T_MAIN_THINK, 'main-think')
      sched(T_MAIN_TOOLS, 'main-tools')
    } else {
      sched(T_GREETING_USER, 'main-user')
      sched(T_GREETING_THINK, 'main-think')
      sched(T_GREETING_REPLY, 'main-tools')
    }

    const toolsStartAt = hasGreeting ? T_MAIN_TOOLS : T_GREETING_REPLY
    const replyAt =
      toolsStartAt +
      cycle.toolStream.length * TOOL_LINE_STAGGER_MS +
      TOOL_END_LAG_MS +
      REPLY_GAP_MS
    sched(replyAt, 'main-reply')

    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [cycle.id, cycle.toolStream.length, hasGreeting])

  // Defer timestamps to post-mount so SSR doesn't pre-render a wall-clock
  // value that disagrees with the client's hydration time (hydration mismatch).
  // Server render: empty strings. Client effect: real "HH:MM" values.
  const [greetingUserT, setGreetingUserT] = useState('')
  const [greetingReplyT, setGreetingReplyT] = useState('')
  const [mainUserT, setMainUserT] = useState('')
  const [mainReplyT, setMainReplyT] = useState('')
  useEffect(() => {
    setGreetingUserT(fmtNow(-180))
    setGreetingReplyT(fmtNow(-150))
    setMainUserT(fmtNow(-30))
    setMainReplyT(fmtNow(60))
  }, [cycle.id])

  // Stage gates , once a stage is reached, the prior stages stay rendered
  // (typing bubbles unmount when their stage ends; chat history accumulates).
  const showGreetingUser =
    hasGreeting &&
    stage !== 'idle'
  const showGreetingTyping = hasGreeting && stage === 'greeting-think'
  const showGreetingReply =
    hasGreeting &&
    (stage === 'greeting-reply' ||
      stage === 'main-user' ||
      stage === 'main-think' ||
      stage === 'main-tools' ||
      stage === 'main-reply')
  const showMainUser =
    stage === 'main-user' ||
    stage === 'main-think' ||
    stage === 'main-tools' ||
    stage === 'main-reply'
  const showMainTyping = stage === 'main-think'
  const showToolBubble = stage === 'main-tools' || stage === 'main-reply'
  const showMainReply = stage === 'main-reply'

  return (
    <div
      className="relative flex h-full min-h-[460px] flex-col overflow-hidden"
      style={{
        background: 'var(--tg-chat-bg)',
        fontFamily: SF_STACK,
        color: 'var(--tg-text)',
      }}
    >
      <ChatWallpaper />
      <ChatHeader
        typing={stage === 'greeting-think' || stage === 'main-think'}
      />

      {/* Bubbles stack from bottom up. Each bubble keeps its own slot , once
          mounted it stays. Typing bubbles unmount cleanly when their stage
          ends (no AnimatePresence that would fight with the next bubble). */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col justify-end overflow-hidden pt-2 pb-2">
        {showGreetingUser && cycle.greeting && (
          <BubbleAppear key={`${cycle.id}-g-user`}>
            <UserBubble text={cycle.greeting.prompt} t={greetingUserT} />
          </BubbleAppear>
        )}
        {showGreetingTyping && (
          <BubbleAppear key={`${cycle.id}-g-typing`}>
            <TypingBubble />
          </BubbleAppear>
        )}
        {showGreetingReply && cycle.greeting && (
          <BubbleAppear key={`${cycle.id}-g-reply`}>
            <ReplyBubble text={cycle.greeting.reply} t={greetingReplyT} compact />
          </BubbleAppear>
        )}
        {showMainUser && (
          <BubbleAppear key={`${cycle.id}-m-user`}>
            <UserBubble text={cycle.prompt} t={mainUserT} />
          </BubbleAppear>
        )}
        {showMainTyping && (
          <BubbleAppear key={`${cycle.id}-m-typing`}>
            <TypingBubble />
          </BubbleAppear>
        )}
        {showToolBubble && (
          <BubbleAppear key={`${cycle.id}-m-tools`}>
            <ToolBubble entries={cycle.toolStream} />
          </BubbleAppear>
        )}
        {showMainReply && (
          <BubbleAppear key={`${cycle.id}-m-reply`}>
            <ReplyBubble text={cycle.reply} t={mainReplyT} />
          </BubbleAppear>
        )}
      </div>

      <Composer />
    </div>
  )
}

function BubbleAppear({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: REPLY_FADE_MS / 1000 }}
    >
      {children}
    </motion.div>
  )
}

// ─────────── helpers ───────────

function fmtNow(offsetSecs = 0) {
  const d = new Date()
  d.setSeconds(d.getSeconds() + offsetSecs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ─────────── doodle wallpaper ───────────

function ChatWallpaper() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <pattern
          id="anima-tg-doodle"
          x="0"
          y="0"
          width="240"
          height="320"
          patternUnits="userSpaceOnUse"
        >
          <g
            fill="none"
            stroke="var(--tg-doodle-stroke)"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M30 40 q14 -22 32 -8 q-4 22 -32 8z" />
            <path d="M46 36 q4 -8 12 -8" />
            <path d="M120 20 l3 9 9 3 -9 3 -3 9 -3 -9 -9 -3 9 -3z" />
            <path d="M180 60 q-12 -14 -22 0 q-4 14 22 26 q26 -12 22 -26 q-10 -14 -22 0z" />
            <path d="M70 130 q22 -36 50 -22 q-6 30 -38 38 z" />
            <path d="M80 140 l28 -22 M84 152 l30 -22 M92 162 l28 -22" />
            <path d="M170 150 l16 -10 16 10 -8 18 -8 6 -8 -6z" />
            <path d="M170 150 l16 6 16 -6 M186 156 l0 18" />
            <path d="M30 220 q14 -10 24 0 q-10 14 -24 8 q-6 -10 8 -14" />
            <path d="M120 220 q-14 0 -14 -12 q0 -16 14 -16 q14 0 14 16 q0 12 -14 12z" />
            <path d="M114 220 l0 16 q0 4 6 4 q6 0 6 -4 l0 -16" />
            <path d="M196 210 a14 14 0 1 0 12 22 a12 12 0 1 1 -12 -22z" />
            <path d="M40 290 l20 -10 -8 -2 6 -10" />
            <path d="M150 290 q12 -22 30 -16 q-4 18 -26 22 z" />
            <path d="M154 296 l22 -14" />
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#anima-tg-doodle)" />
    </svg>
  )
}

// ─────────── conic-gradient Anima avatar ───────────

function AnimaAvatar({ size = 24 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background:
          'conic-gradient(from 210deg, #7c5cff, #3aa6e0, #5dd5b6, #f4d35e, #ef6f6c, #7c5cff)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: 'inset 0 0 0 1.5px rgba(255,255,255,.5)',
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 3,
          borderRadius: '50%',
          background:
            'radial-gradient(circle at 35% 30%, #fff 0, rgba(255,255,255,.6) 30%, transparent 60%), conic-gradient(from 60deg, #6a4dff, #2e8bd6, #4dc7a6, #d9b94e, #d85a57)',
        }}
      />
      <span
        style={{
          position: 'relative',
          color: 'white',
          fontWeight: 700,
          fontSize: size * 0.42,
          letterSpacing: '-0.5px',
          textShadow: '0 1px 2px rgba(0,0,0,.25)',
        }}
      >
        A
      </span>
    </div>
  )
}

// ─────────── frosted iOS header ───────────

function ChatHeader({ typing }: { typing: boolean }) {
  return (
    <div
      className="relative z-20 flex shrink-0 items-center gap-2.5 rounded-t-[14px] px-3 pt-3 pb-2 backdrop-blur-xl sm:rounded-tr-none"
      style={{
        background: 'var(--tg-header-bg)',
        borderBottom: '1px solid var(--tg-divider)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      }}
    >
      <span
        className="inline-flex items-center"
        style={{ fontSize: 13, lineHeight: 1, gap: 1, color: 'var(--tg-accent)' }}
      >
        <svg
          width="6"
          height="11"
          viewBox="0 0 6 11"
          fill="none"
          aria-hidden
          style={{ display: 'block', flexShrink: 0 }}
        >
          <path
            d="M5 1 L1.5 5.5 L5 10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span style={{ marginLeft: -1 }}>Chats</span>
      </span>
      <div className="flex flex-1 flex-col items-center leading-tight">
        <span
          className="text-[14px] font-semibold tracking-[-0.2px]"
          style={{ color: 'var(--tg-name)' }}
        >
          Anima
        </span>
        <span
          className="text-[11px] font-medium"
          style={{ color: typing ? 'var(--tg-accent)' : 'var(--tg-online)' }}
        >
          {typing ? 'typing…' : 'online'}
        </span>
      </div>
      <AnimaAvatar size={30} />
    </div>
  )
}

// ─────────── user bubble (right-aligned, green) ───────────

function UserBubble({ text, t }: { text: string; t: string }) {
  const tailStyle: CSSProperties = {
    position: 'absolute',
    bottom: 0,
    right: -5,
    width: 9,
    height: 14,
    background: 'var(--tg-bubble-out-bg)',
    clipPath: 'path("M0 0 Q 0 14 9 14 L 0 14 Z")',
  }
  return (
    <div className="mt-1.5 flex items-end justify-end gap-1.5 px-2">
      <div
        className="relative text-[12.5px] leading-[1.36]"
        style={{
          maxWidth: '78%',
          background: 'var(--tg-bubble-out-bg)',
          borderRadius: '16px 16px 4px 16px',
          padding: '5px 10px 5px 12px',
          boxShadow: 'var(--tg-bubble-shadow)',
          color: 'var(--tg-text)',
          wordBreak: 'break-word',
        }}
      >
        <div aria-hidden style={tailStyle} />
        <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
        <span
          className="ml-2 inline-flex items-center gap-[3px] text-[10px]"
          style={{
            float: 'right',
            color: 'var(--tg-text-muted)',
            position: 'relative',
            top: 4,
            marginTop: 4,
            lineHeight: 1,
          }}
        >
          {t}
          <svg
            width="14"
            height="10"
            viewBox="0 0 16 11"
            fill="none"
            stroke="var(--tg-check-blue)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M1 6 L4.2 9.2 L9.5 3" />
            <path d="M6.2 9.2 L11.5 3" />
          </svg>
        </span>
        <div style={{ clear: 'both' }} />
      </div>
    </div>
  )
}

// ─────────── tool bubble (left-aligned, white) ───────────

function ToolBubble({ entries }: { entries: ToolStreamEntry[] }) {
  const tailStyle: CSSProperties = {
    position: 'absolute',
    bottom: 0,
    left: -5,
    width: 9,
    height: 14,
    background: 'var(--tg-bubble-in-bg)',
    clipPath: 'path("M9 0 Q 9 14 0 14 L 9 14 Z")',
  }
  return (
    <div className="mt-1.5 flex items-end gap-1.5 px-2">
      <div style={{ width: 24, flexShrink: 0 }}>
        <AnimaAvatar size={24} />
      </div>
      <div
        className="relative"
        style={{
          maxWidth: '85%',
          background: 'var(--tg-bubble-in-bg)',
          borderRadius: '16px 16px 16px 4px',
          padding: '7px 11px 7px 12px',
          boxShadow: 'var(--tg-bubble-shadow)',
          color: 'var(--tg-text)',
        }}
      >
        <div aria-hidden style={tailStyle} />
        <div className="flex flex-col gap-[3px]">
          {entries.map((entry, idx) => (
            <ToolLine
              key={`${entry.tool}-${idx}`}
              entry={entry}
              delaySec={(idx * TOOL_LINE_STAGGER_MS) / 1000}
              endLagSec={TOOL_END_LAG_MS / 1000}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function ToolLine({
  entry,
  delaySec,
  endLagSec,
}: {
  entry: ToolStreamEntry
  delaySec: number
  endLagSec: number
}) {
  const emoji = TOOL_EMOJI[entry.tool] ?? '🔧'
  const ok = entry.status === 'ok'
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, delay: delaySec }}
      className="flex items-baseline gap-1.5"
      style={{
        fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, monospace',
        fontSize: 11.5,
        lineHeight: 1.4,
        color: 'var(--tg-text-tool-body)',
      }}
    >
      <span>{emoji}</span>
      <span>
        <span style={{ color: 'var(--tg-text-tool-tool)' }}>{entry.tool}</span>
        {entry.args && (
          <>
            <span style={{ color: 'var(--tg-text-tool-colon)' }}>: </span>
            <span style={{ color: 'var(--tg-text-tool-args)' }}>{entry.args}</span>
          </>
        )}
      </span>
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15, delay: delaySec + endLagSec }}
        className="ml-auto pl-1.5"
        style={{ color: ok ? '#3aa66e' : '#ef4444', fontWeight: 600 }}
      >
        {ok ? '✓' : '✗'}
      </motion.span>
    </motion.div>
  )
}

// ─────────── reply bubble (left-aligned, white, body font) ───────────

function ReplyBubble({
  text,
  t,
  compact,
}: {
  text: string
  t: string
  compact?: boolean
}) {
  const tailStyle: CSSProperties = {
    position: 'absolute',
    bottom: 0,
    left: -5,
    width: 9,
    height: 14,
    background: 'var(--tg-bubble-in-bg)',
    clipPath: 'path("M9 0 Q 9 14 0 14 L 9 14 Z")',
  }
  return (
    <div className={`${compact ? 'mt-0.5' : 'mt-1'} flex items-end gap-1.5 px-2`}>
      <div style={{ width: 24, flexShrink: 0 }}>
        {/* show avatar for greeting-reply (compact = follows greeting user
            directly), but suppress for main reply (already shown by tool bubble) */}
        {compact && <AnimaAvatar size={24} />}
      </div>
      <div
        className="relative text-[12.5px] leading-[1.4]"
        style={{
          maxWidth: '85%',
          background: 'var(--tg-bubble-in-bg)',
          borderRadius: '16px 16px 16px 4px',
          padding: '7px 11px 7px 12px',
          boxShadow: 'var(--tg-bubble-shadow)',
          color: 'var(--tg-text)',
          wordBreak: 'break-word',
        }}
      >
        <div aria-hidden style={tailStyle} />
        <span
          style={{ whiteSpace: 'pre-wrap' }}
          dangerouslySetInnerHTML={{
            __html: text.replace(
              /\*\*(.*?)\*\*/g,
              '<strong style="font-weight:600">$1</strong>',
            ),
          }}
        />
        <span
          className="ml-2 inline-flex items-center gap-[3px] text-[10px]"
          style={{
            float: 'right',
            color: 'var(--tg-text-muted)',
            position: 'relative',
            top: 4,
            marginTop: 4,
            lineHeight: 1,
          }}
        >
          {t}
        </span>
        <div style={{ clear: 'both' }} />
      </div>
    </div>
  )
}

// ─────────── typing bubble (3 bouncing dots) ───────────

function TypingBubble() {
  return (
    <div className="mt-1.5 flex items-end gap-1.5 px-2">
      <div style={{ width: 24 }}>
        <AnimaAvatar size={24} />
      </div>
      <div
        className="flex items-center gap-1"
        style={{
          background: 'var(--tg-bubble-in-bg)',
          padding: '8px 12px',
          borderRadius: '16px 16px 16px 4px',
          boxShadow: 'var(--tg-bubble-shadow)',
        }}
      >
        {[0, 1, 2].map(i => (
          <motion.span
            key={i}
            animate={{ y: [0, -3, 0], opacity: [0.55, 1, 0.55] }}
            transition={{
              duration: 1.1,
              delay: i * 0.15,
              repeat: Number.POSITIVE_INFINITY,
              ease: 'easeInOut',
            }}
            className="block h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--tg-typing-dot)' }}
          />
        ))}
      </div>
    </div>
  )
}

// ─────────── composer ───────────

function Composer() {
  return (
    <div
      className="relative z-20 flex shrink-0 items-center gap-1.5 p-2 backdrop-blur-xl"
      style={{
        background: 'var(--tg-composer-bg)',
        borderTop: '1px solid var(--tg-divider)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
      }}
    >
      <button
        type="button"
        className="grid place-items-center p-1"
        style={{ color: 'var(--tg-icon-muted)' }}
        aria-label="attach"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
      <div
        className="flex flex-1 items-center gap-2 px-2.5"
        style={{
          background: 'var(--tg-composer-input-bg)',
          border: '0.5px solid var(--tg-composer-input-border)',
          borderRadius: 16,
          minHeight: 30,
        }}
      >
        <span
          className="py-[6px] text-[12.5px]"
          style={{ color: 'var(--tg-placeholder)' }}
        >
          Message
        </span>
        <button
          type="button"
          className="ml-auto p-1"
          style={{ color: 'var(--tg-icon-muted)' }}
          aria-label="emoji"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        className="grid place-items-center p-1"
        style={{ color: 'var(--tg-icon-muted)' }}
        aria-label="voice"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>
    </div>
  )
}
