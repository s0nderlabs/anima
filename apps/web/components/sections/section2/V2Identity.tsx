'use client'

import { motion } from 'framer-motion'
import { CONTRACTS, addressUrl, truncate } from '@/lib/chainscan'
import { SPECTER, SPECTER_SLOTS } from '@/lib/snapshot'

const cardEntrance = {
  hidden: { opacity: 0, y: 30, rotate: -0.6 },
  show: {
    opacity: 1,
    y: 0,
    rotate: 0,
    transition: { duration: 1.1, ease: [0.22, 1, 0.36, 1] },
  },
}

export function V2Identity() {
  return (
    <section
      id="layer-identity"
      className="relative flex min-h-screen items-center py-[var(--section-py)]"
    >
      <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 sm:px-8">
        <LayerHeader title="Identity" pill="0G Chain · ERC-7857" idx="01" />
        <div className="grid items-center gap-12 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-5">
            <motion.h2
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
              className="font-display text-[clamp(36px,5vw,68px)] font-light leading-[1.04] tracking-[-0.018em] text-[var(--color-ink)]"
            >
              An agent <span className="font-italic-serif italic">stamped</span> into chain.
            </motion.h2>
            <p className="max-w-md text-[15px] leading-relaxed text-[var(--color-ink-2)]">
              Every anima is an iNFT under ERC-7857 on 0G Chain. Six IntelligentData slots anchor
              everything intrinsic to the agent: keystore, memory index, identity, persona,
              profile, activity log. Transfer the iNFT, transfer the agent.
            </p>
            <div className="font-mono inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] px-3 py-1.5 text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-2)]">
              <span className="block h-1.5 w-1.5 rounded-full bg-[var(--color-ink)]" />
              token #{SPECTER.iNFT} · specter
            </div>
          </div>

          <div className="lg:col-span-7">
            <motion.div
              variants={cardEntrance}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, amount: 0.3 }}
              className="relative mx-auto max-w-[520px]"
            >
              <CertificateCard />
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  )
}

function CertificateCard() {
  return (
    <div
      className="relative rounded-[10px] bg-[var(--color-cream-warm)] p-7"
      style={{ boxShadow: 'var(--shadow-doc-asym)' }}
    >
      <motion.div
        animate={{ opacity: [0.5, 0.85, 0.5] }}
        transition={{ duration: 6, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-[10px] border border-[var(--color-ink)]"
      />
      <div className="font-mono mb-1 text-[10.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
        ANIMA AGENT NFT · ERC-7857
      </div>
      <div className="font-display mb-5 flex items-baseline justify-between gap-3 text-[28px] font-medium leading-none text-[var(--color-ink)]">
        <span>token #{SPECTER.iNFT}</span>
        <span className="font-body text-[15px] font-medium text-[var(--color-ink-2)]">
          specter
        </span>
      </div>

      <div className="space-y-1.5 border-y border-[var(--color-border)] py-4">
        {SPECTER_SLOTS.map((slot, idx) => (
          <motion.div
            key={slot.name}
            initial={{ opacity: 0, x: -6 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.4, delay: 0.5 + idx * 0.06 }}
            className="font-mono flex items-baseline justify-between gap-3 text-[12px]"
          >
            <span className="text-[var(--color-ink-2)]">slot · {slot.name}</span>
            <span className="text-[var(--color-ink)]">{slot.hash}</span>
          </motion.div>
        ))}
      </div>

      <div className="font-mono mt-4 flex flex-col gap-2 text-[12px]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[var(--color-ink-3)] uppercase tracking-[0.16em]">owner</span>
          <span className="text-[var(--color-ink)]">{truncate(SPECTER.owner, 6, 4)}</span>
        </div>
        <a
          href={addressUrl(CONTRACTS.AnimaAgentNFT)}
          target="_blank"
          rel="noreferrer"
          className="flex items-baseline justify-between gap-3 text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
        >
          <span className="uppercase tracking-[0.16em]">contract</span>
          <span>
            {truncate(CONTRACTS.AnimaAgentNFT, 8, 6)} <span aria-hidden>↗</span>
          </span>
        </a>
      </div>

      {/* Faux corner stamps for "document" feel */}
      <CornerStamp className="-top-3 left-6" label="0G CHAIN" />
      <CornerStamp className="-bottom-3 right-6 rotate-3" label="VERIFIED" />
    </div>
  )
}

function CornerStamp({ className, label }: { className: string; label: string }) {
  return (
    <div
      className={`pointer-events-none absolute font-mono select-none rounded-full border border-[var(--color-ink-2)] bg-[var(--color-paper)] px-3 py-1 text-[9px] uppercase tracking-[0.22em] text-[var(--color-ink-2)] ${className}`}
    >
      {label}
    </div>
  )
}

export function LayerHeader({ idx, title, pill }: { idx: string; title: string; pill: string }) {
  return (
    <div className="mb-12 flex items-center justify-between gap-6 text-[var(--color-ink-2)]">
      <div className="flex items-baseline gap-4">
        <span className="font-mono text-[12px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
          {idx}
        </span>
        <span className="font-display text-[24px] font-light tracking-tight text-[var(--color-ink)]">
          {title}
        </span>
      </div>
      <span className="font-mono inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-paper)] px-3 py-1 text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-ink-2)]">
        {pill}
      </span>
    </div>
  )
}
