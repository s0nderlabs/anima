'use client'

import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import Image from 'next/image'
import { ENIGMA, SNAPSHOT_TAKEN_AT } from '@/lib/snapshot'
import { CONTRACTS, addressUrl } from '@/lib/chainscan'

const NODES = [
  { id: 'agentNFT', label: 'AnimaAgentNFT', sub: 'iNFT · ERC-7857', x: 590, y: 80, role: 'identity' },
  { id: 'storage', label: '0G Storage', sub: 'memory + activity', x: 130, y: 220, role: 'memory' },
  { id: 'compute', label: '0G Compute', sub: 'TeeML · GLM-5', x: 1050, y: 220, role: 'brain' },
  { id: 'inbox', label: 'AnimaInbox', sub: 'A2A · ECIES', x: 200, y: 540, role: 'comms' },
  { id: 'market', label: 'AnimaMarket', sub: 'jobs · ERC-8183', x: 980, y: 540, role: 'market' },
  { id: 'fox', label: 'fox.anima.0g', sub: 'token #3', x: 70, y: 420, role: 'agent' },
  { id: 'specter', label: 'specter.anima.0g', sub: 'token #1', x: 1110, y: 420, role: 'agent' },
  { id: 'tui', label: 'TUI', sub: 'operator stdin', x: 60, y: 60, role: 'surface' },
  { id: 'tg', label: 'Telegram', sub: 'pairing · @anima_*_bot', x: 1120, y: 60, role: 'surface' },
] as const

const EDGES: Array<{ from: string; to: string; particle: string }> = [
  { from: 'enigma', to: 'agentNFT', particle: 'hex' },
  { from: 'enigma', to: 'storage', particle: 'hex' },
  { from: 'enigma', to: 'compute', particle: 'cursor' },
  { from: 'enigma', to: 'inbox', particle: 'envelope' },
  { from: 'enigma', to: 'market', particle: 'gavel' },
  { from: 'inbox', to: 'fox', particle: 'envelope' },
  { from: 'market', to: 'specter', particle: 'gavel' },
  { from: 'tui', to: 'enigma', particle: 'cursor' },
  { from: 'tg', to: 'enigma', particle: 'cursor' },
]

const ENIGMA_POS = { x: 590, y: 320 }

export function Mindmap() {
  const [hovered, setHovered] = useState<string | null>(null)

  return (
    <div className="relative">
      <div className="mb-10 flex items-end justify-between gap-6">
        <div>
          <div className="kicker mb-3">CHAPTER · III</div>
          <h2 className="font-display max-w-[680px] text-[clamp(40px,5.4vw,72px)] font-light leading-[1.02] tracking-[-0.018em] text-[var(--color-ink)]">
            Sovereignty, <span className="font-italic-serif italic">proven</span>.
          </h2>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--color-ink-2)]">
            Every line on this graph is a 0G primitive. Not a brand-name VPS, not someone's
            laptop, not a daemon babysat by an operator. Just protocol , alive, attesting, anchoring.
          </p>
        </div>
        <span className="font-mono inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-paper)] px-3 py-1.5 text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          ↻ snapshot · {new Date(SNAPSHOT_TAKEN_AT).toUTCString().replace('GMT', 'UTC')}
        </span>
      </div>

      <div className="relative aspect-[1180/640] w-full overflow-hidden rounded-[16px] border border-[var(--color-border-strong)] bg-[var(--color-cream)] shadow-[0_30px_80px_-50px_rgba(40,28,18,0.4)]">
        {/* Aurelia atmospheric wash */}
        <Image
          src="/aurelia/cloud-islands.png"
          alt=""
          fill
          aria-hidden
          priority
          quality={70}
          sizes="100vw"
          className="object-cover opacity-[0.16]"
          style={{ filter: 'blur(70px) saturate(0.8)', transform: 'scale(1.15)' }}
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[var(--color-cream)]/85 via-[var(--color-cream)]/55 to-[var(--color-cream)]/85" />

        <svg
          role="img"
          aria-label="Anima decentralized system map: enigma at the center connected to 0G primitives, other agents, and operator surfaces."
          viewBox="0 0 1180 640"
          className="absolute inset-0 h-full w-full"
        >
          <title>Anima decentralized system map</title>
          <desc>
            Enigma anima at the center connected to 0G Storage, 0G Compute, AnimaAgentNFT,
            AnimaInbox, AnimaMarket, and operator input surfaces (TUI and Telegram).
          </desc>
          <defs>
            <radialGradient id="alivePulse" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0%" stopColor="var(--color-ink)" stopOpacity="0.18" />
              <stop offset="60%" stopColor="var(--color-ink)" stopOpacity="0.05" />
              <stop offset="100%" stopColor="var(--color-ink)" stopOpacity="0" />
            </radialGradient>
            <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 8 5 L 0 10 z" fill="var(--color-ink-2)" />
            </marker>
          </defs>

          {/* Edges */}
          {EDGES.map((edge, i) => {
            const fromPos = edge.from === 'enigma' ? ENIGMA_POS : NODES.find(n => n.id === edge.from)!
            const toPos = edge.to === 'enigma' ? ENIGMA_POS : NODES.find(n => n.id === edge.to)!
            const isActive =
              !hovered ||
              hovered === edge.from ||
              hovered === edge.to ||
              (hovered === 'enigma' && (edge.from === 'enigma' || edge.to === 'enigma'))
            const path = curvedPath(fromPos.x, fromPos.y, toPos.x, toPos.y)
            return (
              <g key={`${edge.from}-${edge.to}-${i}`} opacity={isActive ? 1 : 0.18} style={{ transition: 'opacity 0.3s' }}>
                <motion.path
                  d={path}
                  stroke="var(--color-ink-2)"
                  strokeWidth="1.6"
                  strokeDasharray="4 7"
                  fill="none"
                  initial={{ pathLength: 0, opacity: 0 }}
                  whileInView={{ pathLength: 1, opacity: 1 }}
                  viewport={{ once: true, amount: 0.2 }}
                  transition={{ duration: 1.2, delay: 0.4 + i * 0.08, ease: [0.22, 1, 0.36, 1] }}
                />
                <Particle path={path} kind={edge.particle} delay={i * 0.7} />
              </g>
            )
          })}

          {/* Enigma center node */}
          <g
            onMouseEnter={() => setHovered('enigma')}
            onMouseLeave={() => setHovered(null)}
            style={{ cursor: 'pointer' }}
          >
            <motion.circle
              cx={ENIGMA_POS.x}
              cy={ENIGMA_POS.y}
              r={140}
              fill="url(#alivePulse)"
              animate={{ r: [128, 142, 128] }}
              transition={{ duration: 2.4, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
            />
            <motion.rect
              x={ENIGMA_POS.x - 130}
              y={ENIGMA_POS.y - 78}
              rx={14}
              ry={14}
              width={260}
              height={156}
              fill="var(--color-cream-warm)"
              stroke="var(--color-ink)"
              strokeWidth="1.4"
              initial={{ opacity: 0, scale: 0.8 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.7, delay: 0.2 }}
            />
            <foreignObject
              x={ENIGMA_POS.x - 130}
              y={ENIGMA_POS.y - 78}
              width={260}
              height={156}
              className="pointer-events-none"
            >
              <div className="flex h-full flex-col gap-1 px-5 py-3 text-[11px] text-[var(--color-ink)]">
                <div className="font-mono flex items-center justify-between text-[9.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
                  <span>token #{ENIGMA.iNFT} · enigma</span>
                  <AlivePulseDot />
                </div>
                <div className="font-display mt-0.5 text-[18px] font-medium leading-none text-[var(--color-ink)]">
                  enigma.anima.0g
                </div>
                <div className="font-mono text-[10px] text-[var(--color-ink-2)]">
                  {ENIGMA.hostingEnvironment}
                </div>
                <Uptime />
                <div className="font-mono mt-auto grid grid-cols-3 gap-1 text-[10px]">
                  <Pill label="EOA" value={ENIGMA.balances.eoa.label} />
                  <Pill label="brain" value={ENIGMA.balances.compute.label} />
                  <Pill label="sbx" value={ENIGMA.balances.sandbox.label} />
                </div>
              </div>
            </foreignObject>
          </g>

          {/* Surrounding nodes */}
          {NODES.map(node => (
            <g
              key={node.id}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              opacity={hovered && hovered !== node.id && hovered !== 'enigma' ? 0.45 : 1}
              style={{ transition: 'opacity 0.3s', cursor: 'pointer' }}
            >
              <NodeShape node={node} />
            </g>
          ))}
        </svg>

        <div className="pointer-events-none absolute bottom-3 right-4 flex items-center gap-2 text-[11px] text-[var(--color-ink-3)]">
          <a
            href={addressUrl(CONTRACTS.AnimaAgentNFT)}
            target="_blank"
            rel="noreferrer"
            className="pointer-events-auto font-mono text-[var(--color-ink-2)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
          >
            verify on chainscan ↗
          </a>
        </div>
      </div>

      <p className="mt-6 max-w-xl text-[14px] leading-relaxed text-[var(--color-ink-2)]">
        Every line on this graph is a 0G primitive. No central host. Just protocol.
      </p>
    </div>
  )
}

function curvedPath(x1: number, y1: number, x2: number, y2: number) {
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const ox = (y2 - y1) * 0.18
  const oy = (x1 - x2) * 0.18
  return `M ${x1} ${y1} Q ${cx + ox} ${cy + oy} ${x2} ${y2}`
}

function Particle({ path, kind, delay }: { path: string; kind: string; delay: number }) {
  const id = `path-${kind}-${delay.toFixed(2).replace('.', '_')}`
  return (
    <g aria-hidden>
      <path id={id} d={path} fill="none" stroke="none" />
      <text
        fontSize="14"
        fill="var(--color-ink)"
        fontFamily="var(--font-mono), 'Geist Mono', monospace"
      >
        <textPath href={`#${id}`} startOffset="0%">
          <animate
            attributeName="startOffset"
            from="0%"
            to="100%"
            dur="2.8s"
            begin={`${delay}s`}
            repeatCount="indefinite"
          />
          {kind === 'hex' ? '◇' : kind === 'envelope' ? '✉' : kind === 'gavel' ? '⚖' : '›'}
        </textPath>
      </text>
    </g>
  )
}

function NodeShape({ node }: { node: (typeof NODES)[number] }) {
  const w = 180
  const h = 64
  const isSurface = node.role === 'surface'
  const fill = isSurface ? 'var(--color-cream)' : 'var(--color-paper)'
  const stroke = 'var(--color-ink-2)'
  return (
    <>
      <motion.rect
        x={node.x - w / 2}
        y={node.y - h / 2}
        rx={isSurface ? 32 : 8}
        ry={isSurface ? 32 : 8}
        width={w}
        height={h}
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
        initial={{ opacity: 0, y: 10 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.7, delay: 0.6, ease: [0.22, 1, 0.36, 1] }}
      />
      <foreignObject x={node.x - w / 2} y={node.y - h / 2} width={w} height={h}>
        <div className="flex h-full flex-col items-center justify-center px-3 py-2 text-center">
          <span className="font-display text-[14px] leading-none text-[var(--color-ink)]">{node.label}</span>
          <span className="font-mono mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
            {node.sub}
          </span>
        </div>
      </foreignObject>
    </>
  )
}

function AlivePulseDot() {
  return (
    <motion.span
      animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.4, 1] }}
      transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
      className="inline-flex items-center gap-1 text-[var(--color-ink)]"
    >
      <span className="block h-1.5 w-1.5 rounded-full bg-[var(--color-ink)]" />
      alive
    </motion.span>
  )
}

function Uptime() {
  const [delta, setDelta] = useState<number>(ENIGMA.uptimeSeconds)
  useEffect(() => {
    const id = setInterval(() => setDelta(d => d + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const h = Math.floor(delta / 3600)
  const m = Math.floor((delta % 3600) / 60)
  const s = delta % 60
  return (
    <div className="font-mono mt-1 flex items-baseline justify-between text-[10px] text-[var(--color-ink-2)]">
      <span className="uppercase tracking-[0.18em]">uptime</span>
      <span className="text-[var(--color-ink)]">
        {h}h {String(m).padStart(2, '0')}m {String(s).padStart(2, '0')}s
      </span>
    </div>
  )
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-cream)]/55 px-1.5 py-1 text-center">
      <div className="text-[8.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
        {label}
      </div>
      <div className="text-[10.5px] text-[var(--color-ink)]">{value}</div>
    </div>
  )
}
