/**
 * Static reading mock — all 4 cycles' end-state content side by side.
 * Renders the chat surface (left) and voyage panel (right) for each cycle
 * as plain readable typography, not the real animated canvases. The point
 * is to read every prompt, tool block, reply, narration, and proof line
 * in one scroll, without waiting for the autoplay loop to walk through.
 */

import { CYCLES, type Cycle } from '@/lib/cycles'
import type { GlyphKind, Provenance } from '@/lib/provenance'
import { PROVENANCE } from '@/lib/provenance'

export default function CyclesMockPage() {
  return (
    <div className="min-h-screen bg-[var(--color-paper)] py-12">
      <div className="mx-auto max-w-[1400px] px-6">
        <header className="mb-12">
          <h1 className="font-display text-[40px] leading-[1.05] font-light tracking-tight text-[var(--color-ink)]">
            Cycle preview · all 4
          </h1>
          <p className="font-body mt-3 text-[14px] text-[var(--color-ink-2)]">
            Frozen end-state of every cycle. Left = chat surface (TUI / TG). Right = voyage panel
            (the on-chain trail). Read top to bottom; cycles don&apos;t auto-rotate here.
          </p>
        </header>

        <div className="space-y-12">
          {CYCLES.map((cycle, idx) => (
            <CycleBlock key={cycle.id} cycle={cycle} index={idx + 1} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─────────── single cycle block ───────────

function CycleBlock({ cycle, index }: { cycle: Cycle; index: number }) {
  const provenance = PROVENANCE[cycle.id]
  return (
    <section className="rounded-[20px] border border-[var(--color-border)] bg-[var(--color-cream)] p-8 shadow-[0_20px_40px_-30px_rgba(40,28,18,0.3)]">
      {/* header */}
      <div className="mb-6 flex items-baseline justify-between gap-4 border-b border-[var(--color-border)] pb-4">
        <div>
          <div className="font-mono text-[11px] tracking-[0.06em] text-[var(--color-ink-3)]">
            CYCLE {index}
          </div>
          <h2 className="font-display mt-1 text-[24px] font-light leading-tight text-[var(--color-ink)]">
            {cycle.id}
          </h2>
        </div>
        <div className="font-mono flex items-center gap-3 text-[10.5px] tracking-[0.06em] text-[var(--color-ink-2)]">
          <Pill>{cycle.surface.toUpperCase()}</Pill>
          <Pill>{cycle.painting}</Pill>
          <Pill>{cycle.toolStream.length} tools</Pill>
          <Pill>{cycle.durationMs}ms</Pill>
        </div>
      </div>

      {/* 2-col body */}
      <div className="grid gap-10 lg:grid-cols-2">
        <ChatColumn cycle={cycle} />
        <VoyageColumn provenance={provenance} />
      </div>
    </section>
  )
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[var(--color-ink-2)]">
      {children}
    </span>
  )
}

// ─────────── left column · chat ───────────

function ChatColumn({ cycle }: { cycle: Cycle }) {
  return (
    <div>
      <h3 className="font-mono mb-4 text-[10.5px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
        Chat ({cycle.surface === 'tui' ? 'TUI' : 'Telegram'})
      </h3>

      <div className="space-y-4 font-mono text-[12.5px] leading-[1.55] text-[var(--color-ink)]">
        {/* sys line */}
        <Line label="sys" labelColor="rgba(26, 20, 16, 0.40)">
          <span style={{ color: 'rgba(26, 20, 16, 0.40)' }}>
            connected to anima.0g · 0G mainnet
          </span>
        </Line>

        {/* greeting (TG only) */}
        {cycle.greeting ? (
          <>
            <Line label="you" labelColor="#2a78a8">
              {cycle.greeting.prompt}
            </Line>
            <Line label="anima" labelColor="#3a8e5e">
              {cycle.greeting.reply}
            </Line>
          </>
        ) : null}

        {/* user prompt */}
        <Line label="you" labelColor="#2a78a8">
          <span style={{ whiteSpace: 'pre-wrap' }}>{cycle.prompt}</span>
        </Line>

        {/* anima tool block + reply */}
        <Line label="anima" labelColor="#3a8e5e">
          <div className="flex flex-col">
            {cycle.toolStream.map((entry, idx) => (
              <div key={`${entry.tool}-${idx}`} className="mt-1.5 first:mt-0">
                <div className="flex items-baseline gap-1.5">
                  <span>●</span>
                  <span>{entry.tool}</span>
                  {entry.args ? (
                    <span style={{ color: 'var(--color-ink-3)' }}>({entry.args})</span>
                  ) : null}
                </div>
                <div className="pl-[14px]" style={{ color: 'var(--color-ink-3)' }}>
                  └{' '}
                  <span
                    style={{
                      color: entry.status === 'ok' ? '#3a8e5e' : '#c4393a',
                    }}
                  >
                    {entry.status}
                  </span>
                </div>
              </div>
            ))}

            <div
              className="font-body mt-4 text-[13px] leading-[1.55] text-[var(--color-ink)]"
              style={{ whiteSpace: 'pre-wrap' }}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted local cycle content
              dangerouslySetInnerHTML={{
                __html: cycle.reply.replace(
                  /\*\*(.*?)\*\*/g,
                  '<strong style="font-weight:600">$1</strong>',
                ),
              }}
            />
          </div>
        </Line>
      </div>
    </div>
  )
}

function Line({
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
      <span style={{ color: labelColor, fontWeight: 500 }}>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

// ─────────── right column · voyage ───────────

function VoyageColumn({
  provenance,
}: {
  provenance: Provenance | undefined
}) {
  if (!provenance) {
    return <div className="text-[var(--color-ink-3)]">no provenance for this cycle</div>
  }
  return (
    <div className="rounded-[14px] bg-[var(--color-cream-warm)] p-6">
      <h3 className="font-mono mb-1 text-[10.5px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
        Voyage
      </h3>
      <div className="font-italic mt-2 text-[20px] italic leading-tight text-[var(--color-ink)]">
        behind the chat
      </div>
      <div className="font-body mt-1 text-[12px] text-[var(--color-ink-2)]">{provenance.intro}</div>

      <ol className="mt-6 space-y-5">
        {provenance.receipts.map((r, idx) => (
          <li
            key={r.id}
            className="grid items-start gap-3"
            style={{ gridTemplateColumns: '24px 1fr 36px' }}
          >
            {/* node dot column */}
            <div className="flex flex-col items-center pt-[6px]">
              <div className="h-[9px] w-[9px] rounded-full bg-[var(--color-ink)]" />
              {idx < provenance.receipts.length - 1 ? (
                <div
                  className="mt-1 w-[1.5px] flex-1"
                  style={{
                    background: 'var(--color-ink)',
                    minHeight: 36,
                  }}
                />
              ) : null}
            </div>
            {/* annotation — layer label + narration + optional verify link.
                No algorithm names, no hash chunks, no debug timing — those
                are noise for non-crypto readers. The narration carries the
                meaning; only the chain anchor stations show a link, since
                that's where someone could actually verify on chainscan. */}
            <div className="min-w-0">
              <div className="font-mono text-[10.5px] tracking-[0.06em] text-[var(--color-ink-2)]">
                {r.layer}
              </div>
              <p className="font-body mt-1 text-[14px] leading-[1.5] text-[var(--color-ink)]">
                {r.narration}
              </p>
              {r.proofHref ? (
                <a
                  href={r.proofHref}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono mt-2 inline-block text-[10.5px] text-[var(--color-ink-3)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
                >
                  verify on chain ↗
                </a>
              ) : null}
            </div>
            {/* glyph slot — just label since we're not animating */}
            <div className="font-mono pt-[2px] text-right text-[9px] text-[var(--color-ink-3)]">
              {glyphSymbol(r.glyph)}
            </div>
          </li>
        ))}
      </ol>

      {/* outcome */}
      <div className="mt-7 flex items-baseline gap-2 border-t border-[var(--color-border)] pt-4 pl-[27px]">
        <span className="font-italic text-[12px] italic text-[var(--color-ink-3)]">outcome</span>
        <span className="font-body text-[13px] text-[var(--color-ink)]">{provenance.outcome}</span>
      </div>
    </div>
  )
}

// Quick text glyph for each animated SVG. Just a visual hint of the kind.
function glyphSymbol(kind: GlyphKind): string {
  switch (kind) {
    case 'sign':
      return '✎'
    case 'brain':
      return '⬣'
    case 'browser':
      return '◫'
    case 'lock':
      return '⊓'
    case 'anchor':
      return '⚓'
    case 'swap':
      return '⇄'
    case 'stake':
      return '⬢'
    case 'message':
      return '✉'
    case 'gavel':
      return '⚖'
  }
}
