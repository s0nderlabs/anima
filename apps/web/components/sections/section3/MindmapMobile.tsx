'use client'

import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { ENIGMA, SNAPSHOT_TAKEN_AT_UTC } from '@/lib/snapshot'

export function Mindmap() {
  return (
    <div className="space-y-6">
      <div>
        <div className="kicker mb-3">CHAPTER · III</div>
        <h2 className="font-display text-[44px] font-light leading-[1.02] tracking-[-0.018em] text-[var(--color-ink)]">
          Sovereignty, <span className="font-italic-serif italic">proven</span>.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-[var(--color-ink-2)]">
          Every line in this list is a real on-chain primitive, captured from a live anima running
          right now on 0G Sandbox.
        </p>
      </div>

      <div className="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-paper)] p-5">
        <div className="font-mono mb-2 flex items-center justify-between text-[10.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
          <span>token #{ENIGMA.iNFT} · enigma</span>
          <span className="inline-flex items-center gap-1 text-[var(--color-ink)]">
            <motion.span
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY }}
              className="block h-1.5 w-1.5 rounded-full bg-[var(--color-ink)]"
            />
            alive
          </span>
        </div>
        <div className="font-display text-[26px] leading-none text-[var(--color-ink)]">
          enigma.anima.0g
        </div>
        <div className="font-mono mt-1 text-[11px] text-[var(--color-ink-2)]">
          {ENIGMA.hostingEnvironment}
        </div>
        <UptimeRow />
        <div className="font-mono mt-3 grid grid-cols-3 gap-2 text-[11px]">
          <Pill label="EOA" value={ENIGMA.balances.eoa.label} />
          <Pill label="brain" value={ENIGMA.balances.compute.label} />
          <Pill label="sbx" value={ENIGMA.balances.sandbox.label} />
        </div>
      </div>

      <div className="space-y-2">
        {ENIGMA.recentActivity.map(item => (
          <div
            key={item.ts}
            className="flex items-baseline justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)] px-3 py-2 text-[12px]"
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-3)]">
              {item.kind}
            </span>
            <span className="text-[var(--color-ink)]">{item.tool}</span>
          </div>
        ))}
      </div>

      <p className="text-[14px] leading-relaxed text-[var(--color-ink-2)]">
        Every line is a 0G primitive. No central host. Just protocol.
      </p>
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
        ↻ snapshot · {SNAPSHOT_TAKEN_AT_UTC}
      </p>
    </div>
  )
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-cream)]/55 px-2 py-1 text-center">
      <div className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
        {label}
      </div>
      <div className="text-[11px] text-[var(--color-ink)]">{value}</div>
    </div>
  )
}

function UptimeRow() {
  const [delta, setDelta] = useState<number>(ENIGMA.uptimeSeconds)
  useEffect(() => {
    const id = setInterval(() => setDelta(d => d + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const h = Math.floor(delta / 3600)
  const m = Math.floor((delta % 3600) / 60)
  const s = delta % 60
  return (
    <div className="font-mono mt-3 flex items-baseline justify-between text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
      <span>uptime</span>
      <span className="text-[var(--color-ink)] normal-case">
        {h}h {String(m).padStart(2, '0')}m {String(s).padStart(2, '0')}s
      </span>
    </div>
  )
}
