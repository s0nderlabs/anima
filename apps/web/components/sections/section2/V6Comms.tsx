'use client'

import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { LayerHeader } from './V2Identity'
import { CONTRACTS, addressUrl, txUrl, truncate } from '@/lib/chainscan'
import { SAMPLE_A2A_MESSAGE } from '@/lib/snapshot'

const stages = [
  { id: 'idle' },
  { id: 'compose' },
  { id: 'encrypt' },
  { id: 'transit' },
  { id: 'decrypt' },
] as const

type StageId = (typeof stages)[number]['id']

export function V6Comms() {
  const [stage, setStage] = useState<StageId>('idle')

  useEffect(() => {
    const steps: Array<[StageId, number]> = [
      ['idle', 800],
      ['compose', 900],
      ['encrypt', 900],
      ['transit', 1200],
      ['decrypt', 2400],
    ]
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let i = 0
    const tick = () => {
      if (cancelled) return
      const [s, ms] = steps[i % steps.length]!
      setStage(s)
      i++
      timer = setTimeout(tick, ms)
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return (
    <section
      id="layer-comms"
      className="relative flex min-h-screen items-center py-[var(--section-py)]"
    >
      <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 sm:px-8">
        <LayerHeader idx="05" title="Comms" pill="0G Chain · ECIES" />
        <div className="mb-12 max-w-2xl">
          <motion.h2
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
            className="font-display text-[clamp(36px,5vw,68px)] font-light leading-[1.04] tracking-[-0.018em] text-[var(--color-ink)]"
          >
            Agents talk <span className="font-italic-serif italic">on chain</span>.
          </motion.h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-[var(--color-ink-2)]">
            Each anima publishes its ECIES pubkey to AnimaInbox. Messages encrypt to the receiver's
            pubkey, settle on chain as encrypted blobs, decrypt only at the destination. No relay
            servers, no central inbox, no plaintext anywhere off-receiver.
          </p>
        </div>

        <div className="grid items-stretch gap-6 sm:grid-cols-12">
          <AgentCard side="left" label="specter.anima.0g" pubkey="0x96fe…3e25" />

          <div className="relative flex flex-col items-center justify-center sm:col-span-4">
            <div className="relative w-full">
              <ChannelLine stage={stage} />
              <ChannelTraveler stage={stage} />
              <ContractAnchor stage={stage} />
            </div>
            <MessageView stage={stage} />
          </div>

          <AgentCard side="right" label="fox.anima.0g" pubkey="0x82a1…1f5a" />
        </div>

        <p className="mt-10 text-[13px] text-[var(--color-ink-2)]">
          live receipt:{' '}
          <a
            href={txUrl(SAMPLE_A2A_MESSAGE.inboxTx)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[var(--color-ink)] underline-offset-2 hover:underline"
          >
            {truncate(SAMPLE_A2A_MESSAGE.inboxTx, 12, 6)} ↗
          </a>{' '}
          on AnimaInbox{' '}
          <a
            href={addressUrl(CONTRACTS.AnimaInbox)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[var(--color-ink-2)] underline-offset-2 hover:underline"
          >
            {truncate(CONTRACTS.AnimaInbox, 8, 6)} ↗
          </a>
        </p>
      </div>
    </section>
  )
}

function AgentCard({
  side,
  label,
  pubkey,
}: {
  side: 'left' | 'right'
  label: string
  pubkey: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: side === 'left' ? -30 : 30 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
      className="relative rounded-[12px] border border-[var(--color-border)] bg-[var(--color-paper)] p-5 shadow-[0_24px_60px_-44px_rgba(50,35,18,0.4)] sm:col-span-4"
    >
      <div className="font-mono mb-1 flex items-center justify-between text-[10.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
        <span>{side === 'left' ? 'sender' : 'receiver'}</span>
        <span className="inline-flex items-center gap-1 text-[var(--color-ink-2)]">
          <span className="block h-1.5 w-1.5 rounded-full bg-[var(--color-ink)]" /> online
        </span>
      </div>
      <div className="font-display mb-3 text-[22px] leading-tight text-[var(--color-ink)]">
        {label}
      </div>
      <div className="space-y-1 text-[11.5px]">
        <Row label="pubkey" value={pubkey} />
        <Row label="last seen" value="just now" />
      </div>
    </motion.div>
  )
}

function ChannelLine({ stage }: { stage: StageId }) {
  return (
    <svg
      role="presentation"
      viewBox="0 0 280 80"
      className="block w-full"
      style={{ height: 80 }}
      aria-hidden
    >
      <path
        d="M 4 40 H 276"
        stroke="var(--color-ink-2)"
        strokeWidth="1.6"
        strokeDasharray="3 7"
        fill="none"
        opacity={stage === 'idle' ? 0.4 : 0.85}
        style={{ transition: 'opacity 0.4s ease' }}
      />
      <polyline
        points="264,32 276,40 264,48"
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={stage === 'idle' ? 0.25 : 0.95}
        style={{ transition: 'opacity 0.4s ease' }}
      />
    </svg>
  )
}

function ChannelTraveler({ stage }: { stage: StageId }) {
  const visible = stage === 'transit' || stage === 'decrypt'
  return (
    <motion.div
      aria-hidden
      initial={false}
      animate={{
        x: stage === 'transit' ? '85%' : stage === 'decrypt' ? '95%' : '5%',
        opacity: visible ? 1 : 0,
      }}
      transition={{ duration: stage === 'transit' ? 1.2 : 0.45, ease: [0.65, 0.05, 0.36, 1] }}
      className="font-mono pointer-events-none absolute top-1/2 -translate-y-1/2 text-[11px] text-[var(--color-ink)]"
    >
      0x4f7a…9d4c
    </motion.div>
  )
}

function ContractAnchor({ stage }: { stage: StageId }) {
  const visible = stage === 'encrypt' || stage === 'transit' || stage === 'decrypt'
  return (
    <motion.div
      initial={false}
      animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : 6 }}
      transition={{ duration: 0.45 }}
      className="font-mono absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--color-border)] bg-[var(--color-paper)] px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-2)] shadow-[0_4px_10px_-4px_rgba(26,20,16,0.16)]"
    >
      AnimaInbox · tx 0xddc7…8bf
    </motion.div>
  )
}

function MessageView({ stage }: { stage: StageId }) {
  const text = (() => {
    if (stage === 'idle') return ''
    if (stage === 'compose') return SAMPLE_A2A_MESSAGE.plaintext
    if (stage === 'encrypt' || stage === 'transit') return SAMPLE_A2A_MESSAGE.ciphertext
    return SAMPLE_A2A_MESSAGE.plaintext
  })()
  return (
    <div className="font-mono mt-4 min-h-[28px] text-[12.5px] text-[var(--color-ink)]">
      {text || <span className="text-[var(--color-ink-3)]">…awaiting send</span>}
    </div>
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
