'use client'

import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { LayerHeader } from './V2Identity'

const MEMORY_BODY = [
  'name: specter',
  'iNFT: 0x9e71...c84721 · token #1',
  'created at block: 4,168,912',
  '',
  '## Origin',
  'Spawned 2026-04-23 by elpabl0 to verify the',
  'multi-agent ECIES message envelope. Now lives in',
  'mainnet, talks to fox over AnimaInbox, takes',
  'audit jobs from operators it has never met.',
]

const HEX_GLYPHS = '0123456789abcdef·'

export function V4Memory() {
  return (
    <section
      id="layer-memory"
      className="relative flex min-h-screen items-center py-[var(--section-py)]"
    >
      <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 sm:px-8">
        <LayerHeader idx="03" title="Memory" pill="0G Storage · iNFT slots" />
        <div className="grid items-center gap-12 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-5">
            <motion.h2
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
              className="font-display text-[clamp(36px,5vw,68px)] font-light leading-[1.04] tracking-[-0.018em] text-[var(--color-ink)]"
            >
              Memory <span className="font-italic-serif italic">encrypted</span>, then anchored.
            </motion.h2>
            <p className="max-w-md text-[15px] leading-relaxed text-[var(--color-ink-2)]">
              Memory is plain markdown on disk, encrypted to a key derived from the agent's own
              private key, written as a blob to 0G Storage, then anchored to the iNFT's
              IntelligentData slot via on-chain hash. Public only to the operator, public forever
              to the chain.
            </p>
          </div>
          <div className="lg:col-span-7">
            <FileCard />
          </div>
        </div>
      </div>
    </section>
  )
}

function FileCard() {
  const [scrambled, setScrambled] = useState(false)

  useEffect(() => {
    let resetTimer: ReturnType<typeof setTimeout> | null = null
    const id = setInterval(() => {
      setScrambled(true)
      resetTimer = setTimeout(() => setScrambled(false), 700)
    }, 8200)
    return () => {
      clearInterval(id)
      if (resetTimer) clearTimeout(resetTimer)
    }
  }, [])

  return (
    <motion.div
      initial={{ opacity: 0, y: 22 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.95, ease: [0.22, 1, 0.36, 1] }}
      className="relative mx-auto max-w-[560px]"
    >
      <div
        className="relative rounded-[10px] bg-[var(--color-paper)] p-6"
        style={{ boxShadow: 'var(--shadow-doc-asym)' }}
      >
        <div className="font-mono mb-3 flex items-center justify-between text-[10.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
          <span>/agent/identity.md</span>
          <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-cream-warm)] px-2 py-0.5 text-[9px] tracking-[0.18em] text-[var(--color-ink-2)]">
            ENCRYPTED
          </span>
        </div>

        <pre className="font-mono mb-4 whitespace-pre-wrap break-words text-[12px] leading-[1.65] text-[var(--color-ink)]">
          {MEMORY_BODY.map((line, i) => (
            <ScrambleLine key={i} line={line} scrambled={scrambled} />
          ))}
        </pre>

        <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3 text-[11.5px]">
          <Row
            label="encryption"
            value="HKDF-SHA256(privkey,'memory-key/v1') · AES-256-GCM"
          />
          <Row label="storage root" value="0xa8b3…4e92" />
          <Row label="slot · memory-index" value="anchored at tx 0x771a…c8e0" />
        </div>
      </div>

      <p className="mt-5 text-center text-[13px] text-[var(--color-ink-2)]">
        private. encrypted. anchored.{' '}
        <a
          href="https://indexer-storage-turbo.0g.ai"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-ink)] underline-offset-2 hover:underline"
        >
          verify on indexer ↗
        </a>
      </p>
    </motion.div>
  )
}

function ScrambleLine({ line, scrambled }: { line: string; scrambled: boolean }) {
  if (!scrambled || line === '') {
    return <span className="block">{line || ' '}</span>
  }
  return (
    <span className="block">
      {line.split('').map((char, i) =>
        char === ' ' ? (
          <span key={i}> </span>
        ) : (
          <motion.span
            key={i}
            animate={{ opacity: [1, 0.4, 1] }}
            transition={{ duration: 0.7, ease: 'easeInOut' }}
            className="inline-block text-[var(--color-ink-2)]"
          >
            {HEX_GLYPHS[Math.floor(Math.random() * HEX_GLYPHS.length)]}
          </motion.span>
        ),
      )}
    </span>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="font-mono flex items-baseline justify-between gap-3 text-[11.5px]">
      <span className="text-[var(--color-ink-3)] uppercase tracking-[0.16em]">{label}</span>
      <span className="text-right text-[var(--color-ink)]">{value}</span>
    </div>
  )
}
