'use client'

import { useSiwe } from '@/components/SiweContext'
import { zgMainnet } from '@/lib/chain/chain'
import { type AgentSummary, getAgentsByOwner } from '@/lib/chain/inft'
import { shortAddress } from '@/lib/format'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { usePublicClient } from 'wagmi'

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; agents: AgentSummary[] }
  | { kind: 'error'; message: string }

export function AgentList() {
  // Prefer the SIWE-session address: it's stable across wallet reconnects.
  const siwe = useSiwe()
  const address = siwe.address
  // Always read against 0G mainnet regardless of wallet's connected chain.
  const client = usePublicClient({ chainId: zgMainnet.id })
  const [state, setState] = useState<LoadState>({ kind: 'idle' })

  useEffect(() => {
    if (!address || !client) {
      setState({ kind: 'idle' })
      return
    }
    let alive = true
    setState({ kind: 'loading' })
    getAgentsByOwner(client, address as Address)
      .then(agents => {
        if (!alive) return
        setState({ kind: 'ready', agents })
      })
      .catch((err: Error) => {
        if (!alive) return
        setState({ kind: 'error', message: err.message })
      })
    return () => {
      alive = false
    }
  }, [address, client])

  if (state.kind === 'idle') return null

  if (state.kind === 'loading') {
    return (
      <div className="grid gap-2">
        <p className="text-[14px] leading-[1.55] text-[var(--color-ink-2)]">
          Scanning chain for every iNFT delivered to {shortAddress(address ?? '')}…
        </p>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="grid gap-2">
        <p className="text-[14px] leading-[1.55] text-[var(--color-ink-2)]">
          Could not read agents from chain. {state.message}
        </p>
      </div>
    )
  }

  if (state.agents.length === 0) {
    return (
      <div className="grid gap-5">
        <p className="font-display text-[clamp(26px,2.8vw,38px)] font-light leading-[1.1] tracking-tight text-[var(--color-ink)]">
          No agents on this wallet.{' '}
          <span className="font-italic-serif italic text-[var(--color-ink-2)]">Yet.</span>
        </p>
        <p className="max-w-[44ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
          Run <code className="font-mono text-[14px] text-[var(--color-ink)]">anima init</code> on
          your machine to mint one. Then come back.
        </p>
        <Link
          href="/#run"
          className="group inline-flex w-fit items-center gap-1.5 pt-1 text-[13.5px] text-[var(--color-ink-2)] transition-colors hover:text-[var(--color-ink)]"
        >
          <span>How to install</span>
          <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </Link>
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      <p className="text-[13px] text-[var(--color-ink-3)]">
        {state.agents.length} agent{state.agents.length === 1 ? '' : 's'} anchored on 0G Chain.
      </p>
      <ul className="mt-4 divide-y divide-[var(--color-border)]">
        {state.agents.map((agent, i) => (
          <motion.li
            key={agent.tokenId.toString()}
            initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.7, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
          >
            <Link
              href={`/console/${agent.tokenId.toString()}`}
              className="group grid grid-cols-[auto_1fr_auto] items-center gap-6 py-7 sm:gap-8"
            >
              <span
                className="font-display font-light leading-[0.85] text-[var(--color-ink)]"
                style={{
                  fontSize: 'clamp(56px, 6vw, 96px)',
                  fontVariationSettings: '"opsz" 144, "SOFT" 0, "WONK" 0',
                }}
                aria-hidden
              >
                {agent.tokenId.toString().padStart(2, '0')}
              </span>
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="text-[13px] font-medium tracking-tight text-[var(--color-ink)]">
                    Agent #{agent.tokenId.toString()}
                  </span>
                  <span className="font-mono text-[12px] text-[var(--color-ink-3)]">
                    mint block {agent.mintBlock.toString()}
                  </span>
                </div>
                <p className="font-mono text-[13.5px] text-[var(--color-ink)]">
                  {shortAddress(agent.owner, 10, 6)}
                </p>
                <p className="text-[13.5px] leading-[1.55] text-[var(--color-ink-2)]">
                  6 slots anchored on 0G Chain · tap to unlock
                </p>
              </div>
              <span
                className="text-[13px] text-[var(--color-ink-2)] transition group-hover:text-[var(--color-ink)]"
                aria-hidden
              >
                Open{' '}
                <span className="inline-block transition-transform group-hover:translate-x-0.5">
                  →
                </span>
              </span>
            </Link>
          </motion.li>
        ))}
      </ul>
    </div>
  )
}
