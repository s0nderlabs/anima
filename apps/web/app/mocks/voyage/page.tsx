'use client'

import { PROVENANCE, type Receipt } from '@/lib/provenance'

const RECEIPTS = PROVENANCE.research.receipts

const PLACES: Record<
  string,
  { name: string; subtitle: string; coord?: string }
> = {
  'r-sign': { name: 'home port', subtitle: 'your laptop', coord: 'N 47° 12′' },
  'r-attest': { name: 'the enclave', subtitle: '0G Compute · TEE', coord: 'E 53° 04′' },
  'r-sandbox': { name: 'the sandbox', subtitle: 'enigma · TDX', coord: 'S 12° 18′' },
  'r-storage': { name: 'the vault', subtitle: '0G Storage · KV', coord: 'W 81° 33′' },
  'r-chain': { name: 'the seal', subtitle: '0G Chain · iNFT #1', coord: 'meridian 0' },
}

export default function VoyageMocks() {
  return (
    <main className="min-h-screen bg-[var(--color-cream)] py-12">
      <div className="mx-auto max-w-[860px] space-y-16 px-6">
        <header>
          <h1 className="font-display text-[36px] leading-tight text-[var(--color-ink)]">
            voyage mocks
          </h1>
          <p className="font-body mt-2 max-w-[60ch] text-[14px] leading-relaxed text-[var(--color-ink-2)]">
            three takes on rendering cycle 1's path through the 0G stack. all
            three use the same five stations, same content, just different
            spatial language. static for comparison; the chosen one gets the
            stamp + animation treatment.
          </p>
        </header>

        <Section
          label="A · cartographic voyage chart"
          note="hand-drawn map. dotted route meanders down through five named places. compass rose, scale bar. lovart-coded."
        >
          <Cartographic />
        </Section>

        <Section
          label="B · architectural cross-section"
          note="le corbusier section drawing. five chambers stacked vertically. the prompt descends through them like a lift."
        >
          <ArchSection />
        </Section>

        <Section
          label="C · constellation"
          note="five stars in a meaningful shape, hairlines connecting in order. astronomical, abstract."
        >
          <Constellation />
        </Section>
      </div>
    </main>
  )
}

function Section({
  label,
  note,
  children,
}: {
  label: string
  note: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--color-ink-3)]">
          {label}
        </div>
        <div className="font-body mt-1 max-w-[60ch] text-[12.5px] italic leading-snug text-[var(--color-ink-2)]">
          {note}
        </div>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-[var(--color-border)] bg-[var(--color-cream-warm)]">
        {children}
      </div>
    </section>
  )
}

// ─── A · Cartographic voyage chart ────────────────────────────────────

function Cartographic() {
  // station coordinates within the 760×600 viewBox. Meandering
  // descent , slight horizontal wander gives the "voyage" feel.
  const STATIONS: Array<{ x: number; y: number; r: Receipt }> = [
    { x: 200, y: 90, r: RECEIPTS[0] },
    { x: 560, y: 200, r: RECEIPTS[1] },
    { x: 180, y: 320, r: RECEIPTS[2] },
    { x: 580, y: 430, r: RECEIPTS[3] },
    { x: 340, y: 540, r: RECEIPTS[4] },
  ]

  // Cubic-bezier route through the points , handcrafted control
  // points so the curve breathes. Dasharray for the dotted look.
  const path =
    `M ${STATIONS[0]!.x} ${STATIONS[0]!.y} ` +
    `C 380 100, 460 130, ${STATIONS[1]!.x} ${STATIONS[1]!.y} ` +
    `C 560 240, 200 240, ${STATIONS[2]!.x} ${STATIONS[2]!.y} ` +
    `C 180 360, 540 360, ${STATIONS[3]!.x} ${STATIONS[3]!.y} ` +
    `C 580 500, 360 500, ${STATIONS[4]!.x} ${STATIONS[4]!.y}`

  return (
    <div className="relative w-full" style={{ aspectRatio: '760 / 620' }}>
      {/* faint Aurelia territory tint */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'url(/aurelia/grove.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.18,
          filter: 'blur(30px) saturate(0.7)',
          mixBlendMode: 'multiply',
        }}
      />

      <svg
        viewBox="0 0 760 620"
        className="relative h-full w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* topographic contour stippling */}
        <g opacity="0.18" stroke="var(--color-ink)" fill="none">
          {Array.from({ length: 7 }).map((_, i) => (
            <ellipse
              // biome-ignore lint/suspicious/noArrayIndexKey: decorative
              key={i}
              cx={380}
              cy={310}
              rx={120 + i * 60}
              ry={80 + i * 38}
              strokeWidth="0.4"
              strokeDasharray="1.5 2"
            />
          ))}
        </g>

        {/* parchment wash on the chart edge */}
        <rect
          x="6"
          y="6"
          width="748"
          height="608"
          fill="none"
          stroke="var(--color-ink-2)"
          strokeWidth="0.6"
          strokeDasharray="3 2"
          opacity="0.4"
        />

        {/* the route , dotted journey */}
        <path
          d={path}
          fill="none"
          stroke="var(--color-ink)"
          strokeWidth="1.2"
          strokeDasharray="3 4"
          strokeLinecap="round"
        />

        {/* stations */}
        {STATIONS.map(({ x, y, r }, i) => {
          const place = PLACES[r.id]!
          const labelLeft = x > 380
          return (
            <g key={r.id}>
              <PlaceMarker x={x} y={y} kind={r.stamp} />
              <g transform={`translate(${labelLeft ? x - 16 : x + 16} ${y - 4})`}>
                <text
                  textAnchor={labelLeft ? 'end' : 'start'}
                  fontFamily="var(--font-italic), serif"
                  fontStyle="italic"
                  fontSize="15"
                  fill="var(--color-ink)"
                >
                  {place.name}
                </text>
                <text
                  textAnchor={labelLeft ? 'end' : 'start'}
                  y="14"
                  fontFamily="var(--font-mono), monospace"
                  fontSize="9"
                  letterSpacing="0.18em"
                  fill="var(--color-ink-2)"
                >
                  {place.subtitle.toUpperCase()}
                </text>
                <text
                  textAnchor={labelLeft ? 'end' : 'start'}
                  y="26"
                  fontFamily="var(--font-mono), monospace"
                  fontSize="8"
                  letterSpacing="0.14em"
                  fill="var(--color-ink-3)"
                >
                  {`station ${String(i + 1).padStart(2, '0')} · ${place.coord ?? ''}`.toUpperCase()}
                </text>
              </g>
            </g>
          )
        })}

        {/* compass rose, top-right */}
        <g transform="translate(700 70)">
          <circle r="22" fill="none" stroke="var(--color-ink)" strokeWidth="0.7" />
          <circle r="17" fill="none" stroke="var(--color-ink-2)" strokeWidth="0.4" strokeDasharray="1 1" />
          <path d="M 0 -19 L 3 0 L 0 19 L -3 0 Z" fill="var(--color-ink)" opacity="0.8" />
          <path d="M -19 0 L 0 3 L 19 0 L 0 -3 Z" fill="var(--color-ink-2)" opacity="0.5" />
          <text x="0" y="-25" textAnchor="middle" fontFamily="serif" fontSize="8" fontStyle="italic" fill="var(--color-ink)">
            N
          </text>
        </g>

        {/* scale bar, bottom-left */}
        <g transform="translate(40 580)">
          <line x1="0" y1="0" x2="80" y2="0" stroke="var(--color-ink)" strokeWidth="1" />
          <line x1="0" y1="-3" x2="0" y2="3" stroke="var(--color-ink)" strokeWidth="1" />
          <line x1="40" y1="-3" x2="40" y2="3" stroke="var(--color-ink-2)" strokeWidth="0.7" />
          <line x1="80" y1="-3" x2="80" y2="3" stroke="var(--color-ink)" strokeWidth="1" />
          <text x="0" y="14" fontFamily="var(--font-mono), monospace" fontSize="8" fill="var(--color-ink-2)" letterSpacing="0.16em">
            0G MAINNET · 16661
          </text>
        </g>

        {/* chart title */}
        <text
          x="40"
          y="40"
          fontFamily="var(--font-italic), serif"
          fontStyle="italic"
          fontSize="22"
          fill="var(--color-ink)"
        >
          a turn through anima
        </text>
        <text
          x="40"
          y="56"
          fontFamily="var(--font-mono), monospace"
          fontSize="9"
          letterSpacing="0.18em"
          fill="var(--color-ink-3)"
        >
          CYCLE 01 · RESEARCH
        </text>
      </svg>
    </div>
  )
}

function PlaceMarker({
  x,
  y,
  kind,
}: {
  x: number
  y: number
  kind: Receipt['stamp']
}) {
  // 28px hand-drawn place glyph centered at (x,y)
  return (
    <g transform={`translate(${x} ${y})`}>
      {/* marker pin shadow */}
      <ellipse cx="2" cy="14" rx="9" ry="2" fill="var(--color-ink)" opacity="0.12" />
      {kind === 'wallet' ? (
        <g stroke="var(--color-ink)" fill="none" strokeWidth="1">
          <circle r="11" />
          <circle r="7" strokeDasharray="1.2 1" opacity="0.6" />
          <path d="M -6 0 Q -2 -5 2 0 T 6 -2" strokeWidth="1.2" />
        </g>
      ) : kind === 'attestation' ? (
        <g stroke="var(--color-ink)" fill="none">
          <circle r="11" strokeWidth="1" />
          <path d="M 0 -7 L 1.5 -1.5 L 7 0 L 1.5 1.5 L 0 7 L -1.5 1.5 L -7 0 L -1.5 -1.5 Z" fill="var(--color-ink)" opacity="0.85" />
        </g>
      ) : kind === 'sandbox' ? (
        <g stroke="var(--color-ink)" fill="none" strokeWidth="1">
          <path d="M -8 -5 L -5 -8 L 5 -8 L 8 -5 L 8 5 L 5 8 L -5 8 L -8 5 Z" />
          <rect x="-4" y="-4" width="8" height="8" strokeWidth="0.7" />
          <line x1="-4" y1="4" x2="4" y2="-4" strokeWidth="0.5" opacity="0.6" />
        </g>
      ) : kind === 'storage' ? (
        <g stroke="var(--color-ink)" fill="none" strokeWidth="1">
          <path d="M -10 -6 L 6 -6 L 10 0 L 6 6 L -10 6 Z" />
          <circle cx="-7" cy="0" r="1.4" strokeWidth="0.6" />
        </g>
      ) : kind === 'chain' ? (
        <g stroke="var(--color-ink)" fill="none" strokeWidth="1">
          <path d="M -5 -10 L 7 -10 L 4 -3 L 7 4 L -5 4 Z" />
          <line x1="-5" y1="-10" x2="-5" y2="11" />
          <circle cx="-5" cy="-10" r="1.4" fill="var(--color-ink)" />
        </g>
      ) : null}
    </g>
  )
}

// ─── B · Architectural cross-section ──────────────────────────────────

function ArchSection() {
  const CHAMBERS = [
    { id: RECEIPTS[0]!.id, layer: 'YOU', name: 'home · your laptop', detail: 'EIP-191 signature' },
    { id: RECEIPTS[1]!.id, layer: 'BRAIN', name: 'the enclave · 0G Compute', detail: 'TeeML · attested' },
    { id: RECEIPTS[2]!.id, layer: 'LIMBS', name: 'the sandbox · enigma', detail: 'TDX TEE · enclosed' },
    { id: RECEIPTS[3]!.id, layer: 'MEMORY', name: 'the vault · 0G Storage', detail: 'AES-256-GCM · root' },
    { id: RECEIPTS[4]!.id, layer: 'CHAIN', name: 'the seal · 0G Chain', detail: 'iNFT update · tx' },
  ]

  return (
    <div className="relative w-full" style={{ aspectRatio: '760 / 620' }}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'url(/aurelia/grove.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.16,
          filter: 'blur(32px)',
          mixBlendMode: 'multiply',
        }}
      />

      <div className="relative flex h-full w-full flex-col px-8 py-7">
        {/* title bar */}
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <div className="font-italic text-[20px] italic text-[var(--color-ink)]">
              section A · A
            </div>
            <div className="font-mono mt-0.5 text-[9px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
              through anima · cycle 01
            </div>
          </div>
          <div className="font-mono text-right text-[9px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
            <div>scale 1 : 1</div>
            <div className="mt-0.5">descending ▾</div>
          </div>
        </div>

        {/* chamber stack */}
        <div className="relative flex flex-1 flex-col rounded-[3px] border border-[var(--color-ink)]">
          {/* descending thread on the left */}
          <div
            aria-hidden
            className="absolute left-[36px] top-0 bottom-0 w-px"
            style={{ background: 'var(--color-ink)', opacity: 0.85 }}
          />

          {CHAMBERS.map((c, i) => (
            <div
              key={c.id}
              className="relative flex-1"
              style={{
                borderTop: i === 0 ? 'none' : '1px solid var(--color-ink)',
              }}
            >
              {/* hatched floor */}
              <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-1.5"
                style={{
                  backgroundImage:
                    'repeating-linear-gradient(135deg, var(--color-ink) 0 0.5px, transparent 0.5px 5px)',
                  opacity: 0.35,
                }}
              />
              {/* chamber inner */}
              <div className="relative grid h-full grid-cols-[60px_1fr_auto] items-center gap-4 px-4">
                {/* layer code on left */}
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-ink)]">
                  {c.layer}
                </div>
                {/* chamber name + detail */}
                <div>
                  <div className="font-italic text-[15px] italic leading-tight text-[var(--color-ink)]">
                    {c.name}
                  </div>
                  <div className="font-mono mt-0.5 text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-2)]">
                    {c.detail}
                  </div>
                </div>
                {/* level marker on right */}
                <div className="font-mono flex items-baseline gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
                  <span>level</span>
                  <span className="text-[var(--color-ink)]">{String(i).padStart(2, '0')}</span>
                </div>
              </div>
              {/* tiny "prompt" dot on the descending thread */}
              <div
                aria-hidden
                className="absolute h-2.5 w-2.5 rounded-full"
                style={{
                  left: 30,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'var(--color-ink)',
                  border: '2px solid var(--color-cream-warm)',
                  boxShadow: '0 0 0 1px var(--color-ink)',
                }}
              />
            </div>
          ))}
        </div>

        {/* foundation line + mainnet label */}
        <div className="mt-2 flex items-center justify-between">
          <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
            foundation · 0G mainnet 16661
          </div>
          <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
            drawn at scale
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── C · Constellation ────────────────────────────────────────────────

function Constellation() {
  // five stars arranged in a descending S , abstract but readable
  const STARS = [
    { x: 220, y: 110, r: RECEIPTS[0]! },
    { x: 530, y: 220, r: RECEIPTS[1]! },
    { x: 200, y: 340, r: RECEIPTS[2]! },
    { x: 540, y: 440, r: RECEIPTS[3]! },
    { x: 340, y: 540, r: RECEIPTS[4]! },
  ]

  // hairline connecting consecutive stars
  const lines = STARS.slice(1).map((s, i) => {
    const prev = STARS[i]!
    return { x1: prev.x, y1: prev.y, x2: s.x, y2: s.y }
  })

  return (
    <div className="relative w-full" style={{ aspectRatio: '760 / 620' }}>
      {/* darker mood background , a midnight vellum */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 40%, rgba(40,28,18,0.10) 0%, transparent 70%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'url(/aurelia/grove.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.12,
          filter: 'blur(40px) saturate(0.4)',
          mixBlendMode: 'multiply',
        }}
      />

      <svg viewBox="0 0 760 620" className="relative h-full w-full">
        {/* background star dust */}
        <g opacity="0.35">
          {Array.from({ length: 60 }).map((_, i) => {
            const x = (i * 73) % 760
            const y = ((i * 113) % 580) + 30
            const r = i % 7 === 0 ? 0.9 : 0.45
            return (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: decorative
                key={i}
                cx={x}
                cy={y}
                r={r}
                fill="var(--color-ink)"
                opacity={0.4 + (i % 3) * 0.2}
              />
            )
          })}
        </g>

        {/* hairline arcs between stars (slight curve, not straight) */}
        {lines.map((l, i) => {
          const mx = (l.x1 + l.x2) / 2
          const my = (l.y1 + l.y2) / 2
          const offset = i % 2 === 0 ? -28 : 28
          const cx = mx + offset
          return (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: decorative
              key={i}
              d={`M ${l.x1} ${l.y1} Q ${cx} ${my} ${l.x2} ${l.y2}`}
              fill="none"
              stroke="var(--color-ink)"
              strokeWidth="0.5"
              strokeDasharray="1.5 2.5"
              opacity="0.55"
            />
          )
        })}

        {/* stars */}
        {STARS.map((s, i) => {
          const place = PLACES[s.r.id]!
          const labelLeft = s.x > 380
          return (
            <g key={s.r.id}>
              {/* halo */}
              <circle
                cx={s.x}
                cy={s.y}
                r="14"
                fill="var(--color-ink)"
                opacity="0.06"
              />
              {/* star */}
              <g transform={`translate(${s.x} ${s.y})`}>
                <path
                  d="M 0 -7 L 1.6 -1.6 L 7 0 L 1.6 1.6 L 0 7 L -1.6 1.6 L -7 0 L -1.6 -1.6 Z"
                  fill="var(--color-ink)"
                />
                <circle r="2" fill="var(--color-cream-warm)" />
              </g>
              {/* label */}
              <g transform={`translate(${labelLeft ? s.x - 14 : s.x + 14} ${s.y + 4})`}>
                <text
                  textAnchor={labelLeft ? 'end' : 'start'}
                  fontFamily="var(--font-italic), serif"
                  fontStyle="italic"
                  fontSize="14"
                  fill="var(--color-ink)"
                >
                  {place.name}
                </text>
                <text
                  textAnchor={labelLeft ? 'end' : 'start'}
                  y="13"
                  fontFamily="var(--font-mono), monospace"
                  fontSize="9"
                  letterSpacing="0.16em"
                  fill="var(--color-ink-2)"
                >
                  {place.subtitle.toUpperCase()}
                </text>
                <text
                  textAnchor={labelLeft ? 'end' : 'start'}
                  y="24"
                  fontFamily="var(--font-mono), monospace"
                  fontSize="8"
                  letterSpacing="0.20em"
                  fill="var(--color-ink-3)"
                >
                  ★ {String(i + 1).padStart(2, '0')}
                </text>
              </g>
            </g>
          )
        })}

        {/* title */}
        <text
          x="40"
          y="44"
          fontFamily="var(--font-italic), serif"
          fontStyle="italic"
          fontSize="22"
          fill="var(--color-ink)"
        >
          one turn, in five stars
        </text>
        <text
          x="40"
          y="60"
          fontFamily="var(--font-mono), monospace"
          fontSize="9"
          letterSpacing="0.18em"
          fill="var(--color-ink-3)"
        >
          ANIMA · CYCLE 01 · RESEARCH
        </text>

        {/* tiny meta in bottom right */}
        <text
          x="720"
          y="600"
          textAnchor="end"
          fontFamily="var(--font-mono), monospace"
          fontSize="8"
          letterSpacing="0.18em"
          fill="var(--color-ink-3)"
        >
          0G MAINNET · 16661
        </text>
      </svg>
    </div>
  )
}
