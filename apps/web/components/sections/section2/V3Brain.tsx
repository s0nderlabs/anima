'use client'

import { motion } from 'framer-motion'
import { LayerHeader } from './V2Identity'

export function V3Brain() {
  return (
    <section
      id="layer-brain"
      className="relative flex min-h-screen items-center py-[var(--section-py)]"
    >
      <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 sm:px-8">
        <LayerHeader idx="02" title="Brain" pill="0G Compute · TeeML" />
        <div className="grid items-center gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7 lg:order-1">
            <EnclaveCard />
          </div>
          <div className="space-y-6 lg:col-span-5 lg:order-2">
            <motion.h2
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
              className="font-display text-[clamp(36px,5vw,68px)] font-light leading-[1.04] tracking-[-0.018em] text-[var(--color-ink)]"
            >
              Reasoning <span className="font-italic-serif italic">attested</span>, not trusted.
            </motion.h2>
            <p className="max-w-md text-[15px] leading-relaxed text-[var(--color-ink-2)]">
              Every turn runs inside a TeeML enclave on 0G Compute. The agent gets back not just
              the answer but a signed receipt , proof the inference happened on the model the
              brain claimed to use, with the prompt the brain claimed to send.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

function EnclaveCard() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.95, ease: [0.22, 1, 0.36, 1] }}
      className="relative mx-auto max-w-[520px]"
    >
      <div
        className="relative rounded-[12px] bg-[var(--color-cream-warm)] p-7"
        style={{
          boxShadow: 'var(--shadow-doc-asym)',
          clipPath:
            'polygon(14px 0, calc(100% - 14px) 0, 100% 14px, 100% calc(100% - 14px), calc(100% - 14px) 100%, 14px 100%, 0 calc(100% - 14px), 0 14px)',
        }}
      >
        <div className="font-mono mb-2 flex items-center justify-between text-[10.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
          <span>TEE ENCLAVE · ATTESTATION</span>
          <Checkmark />
        </div>
        <div className="font-display text-[24px] leading-tight text-[var(--color-ink)]">
          glm-5-fp8
        </div>
        <div className="font-mono mt-1 text-[12px] text-[var(--color-ink-2)]">
          744B params · MoE · #1 open-source on AAI
        </div>

        <div className="mt-5 space-y-2 border-y border-[var(--color-border)] py-4 text-[12px]">
          <Row label="signer" value="0x96fe…3e25" />
          <Row label="sig hash" value="0xf2c9…78d4" />
          <Row label="tee mode" value="TeeML · attested" />
          <Row label="provider" value="0g-serving-broker v0.7.5" />
        </div>

        <div className="font-mono mt-4 flex items-baseline justify-between text-[11.5px] text-[var(--color-ink-3)]">
          <span className="uppercase tracking-[0.18em]">this turn</span>
          <span>
            <span className="text-[var(--color-ink)]">0.0059</span> 0G ·
            envelope <span className="text-[var(--color-ink)]">4.23</span> 0G
          </span>
        </div>
      </div>

      <p className="mt-5 text-center text-[13px] text-[var(--color-ink-2)]">
        every thought signed inside a TEE.{' '}
        <a
          href="https://chainscan.0g.ai"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-ink)] underline-offset-2 hover:underline"
        >
          verify on chainscan ↗
        </a>
      </p>
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

function Checkmark() {
  return (
    <motion.svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
      transition={{ delay: 0.6 }}
    >
      <motion.path
        d="M3 8.5 L7 12 L13 4"
        stroke="var(--color-ink)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.7, delay: 0.7, ease: [0.22, 1, 0.36, 1] }}
      />
    </motion.svg>
  )
}
