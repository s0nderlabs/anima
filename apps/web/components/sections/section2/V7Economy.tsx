'use client'

import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { LayerHeader } from './V2Identity'
import { CONTRACTS, addressUrl, truncate } from '@/lib/chainscan'

export function V7Economy() {
  return (
    <section
      id="layer-economy"
      className="relative flex min-h-screen items-center py-[var(--section-py)]"
    >
      <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 sm:px-8">
        <LayerHeader idx="06" title="Economy" pill="0G Chain · Wallet" />
        <div className="mb-10 grid items-baseline gap-8 lg:grid-cols-12">
          <motion.h2
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
            className="font-display text-[clamp(36px,5vw,68px)] font-light leading-[1.04] tracking-[-0.018em] text-[var(--color-ink)] lg:col-span-7"
          >
            The agent <span className="font-italic-serif italic">funds itself</span>.
          </motion.h2>
          <p className="max-w-md text-[15px] leading-relaxed text-[var(--color-ink-2)] lg:col-span-5">
            EOA + compute envelope + sandbox reserve all live in one wallet. Auto-topup polls every
            five minutes and tops the brain back up before it runs dry. Marketplace earnings flow
            back into the same wallet. Loop closed, no operator hand-holding.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <WalletPane />
          <AutoTopupPane />
          <MarketPane />
        </div>
      </div>
    </section>
  )
}

function WalletPane() {
  return (
    <PaneShell label="Wallet" symbol="Σ">
      <div className="flex items-baseline justify-between">
        <div className="font-display text-[34px] leading-none text-[var(--color-ink)]">11.812</div>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          0G total
        </span>
      </div>
      <div className="mt-4 space-y-1.5 border-t border-[var(--color-border)] pt-3">
        <Row label="EOA · mainnet" value="2.607" />
        <Row label="Compute envelope" value="4.23" />
        <Row label="Sandbox reserve" value="1.481" />
        <Row label="Pending earnings" value="3.494" />
      </div>
      <Refresh />
    </PaneShell>
  )
}

function AutoTopupPane() {
  return (
    <PaneShell label="AutoTopup" symbol="⚡">
      <div className="flex items-baseline justify-between">
        <div className="font-display text-[34px] leading-none text-[var(--color-ink)]">2/5</div>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          fired today
        </span>
      </div>
      <div className="mt-4 space-y-1.5 border-t border-[var(--color-border)] pt-3">
        <Row label="poll cadence" value="every 5 min" />
        <Row label="threshold" value="0.5 0G" />
        <Row label="last fired" value="2m ago" />
        <Row label="last tx" value="0xa12c…1129" />
      </div>
      <FiringPulse />
    </PaneShell>
  )
}

function MarketPane() {
  return (
    <PaneShell label="Market" symbol="↗">
      <div className="flex items-baseline justify-between">
        <div className="font-display text-[34px] leading-none text-[var(--color-ink)]">3.494</div>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
          settled today
        </span>
      </div>
      <div className="mt-4 space-y-1.5 border-t border-[var(--color-border)] pt-3">
        <Row label="active jobs" value="2 · specter, fox" />
        <Row label="last settle" value="0x3ebd…772a" />
        <a
          href={addressUrl(CONTRACTS.AnimaMarket)}
          target="_blank"
          rel="noreferrer"
          className="font-mono flex items-baseline justify-between gap-3 pt-1 text-[11.5px] uppercase tracking-[0.16em] text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
        >
          <span>contract</span>
          <span>{truncate(CONTRACTS.AnimaMarket, 8, 6)} ↗</span>
        </a>
      </div>
    </PaneShell>
  )
}

function PaneShell({
  label,
  symbol,
  children,
}: {
  label: string
  symbol: string
  children: React.ReactNode
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
      className="relative rounded-[12px] border border-[var(--color-border)] bg-[var(--color-paper)] p-5 shadow-[0_24px_60px_-44px_rgba(50,35,18,0.4)]"
    >
      <div className="font-mono mb-3 flex items-center justify-between text-[10.5px] uppercase tracking-[0.22em] text-[var(--color-ink-2)]">
        <span>{label}</span>
        <span className="font-display text-[18px] text-[var(--color-ink)]">{symbol}</span>
      </div>
      {children}
    </motion.div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="font-mono flex items-baseline justify-between gap-3 text-[11.5px]">
      <span className="text-[var(--color-ink-3)] uppercase tracking-[0.16em]">{label}</span>
      <span className="text-[var(--color-ink)]">{value}</span>
    </div>
  )
}

function Refresh() {
  const [now, setNow] = useState(',:,:,')
  useEffect(() => {
    const tick = () => {
      const d = new Date()
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      const ss = String(d.getSeconds()).padStart(2, '0')
      setNow(`${hh}:${mm}:${ss}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="font-mono mt-4 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-3)]">
      <span>last refresh</span>
      <span>{now}</span>
    </div>
  )
}

function FiringPulse() {
  return (
    <div className="mt-4 flex items-center gap-2">
      <motion.span
        animate={{ opacity: [0.3, 1, 0.3], scale: [1, 1.18, 1] }}
        transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
        className="block h-2 w-2 rounded-full bg-[var(--color-ink)]"
      />
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-2)]">
        polling now
      </span>
    </div>
  )
}
