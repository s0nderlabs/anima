'use client'

import { explorerAddrUrl } from '@/lib/chain/chain'
import { formatBalanceOG, shortAddress } from '@/lib/format'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { useBalance } from 'wagmi'

export function WalletPanel({ agentAddress }: { agentAddress: Address | null }) {
  if (!agentAddress) {
    return (
      <div className="grid gap-3 pt-6">
        <span className="kicker">WALLET · WAITING ON SUBNAME</span>
        <p className="max-w-[44ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
          We could not resolve this agent’s wallet address from the SANN registry. Once registered,
          the agent EOA shows here with its on-chain balance.
        </p>
      </div>
    )
  }
  return <Inner agentAddress={agentAddress} />
}

function Inner({ agentAddress }: { agentAddress: Address }) {
  const { data, isLoading, error } = useBalance({ address: agentAddress })
  const [shimmer, setShimmer] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setShimmer(true), 60)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="grid gap-12 pt-6 sm:gap-16">
      <section className="grid gap-5">
        <span className="kicker">AGENT EOA · NATIVE BALANCE</span>
        <div className="grid gap-1">
          {isLoading ? (
            <span className="font-mono text-[12.5px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
              reading chain…
            </span>
          ) : error ? (
            <span className="font-mono text-[12.5px] uppercase tracking-[0.22em] text-[var(--color-ink-2)]">
              error · {error.message}
            </span>
          ) : data ? (
            <p
              className="font-display font-light leading-[0.9] text-[var(--color-ink)]"
              style={{
                fontSize: 'clamp(56px, 7vw, 116px)',
                fontVariationSettings: '"opsz" 144, "SOFT" 0, "WONK" 0',
                opacity: shimmer ? 1 : 0,
                transition: 'opacity 0.6s cubic-bezier(0.22,1,0.36,1)',
              }}
            >
              {formatBalanceOG(data.value)}{' '}
              <span className="font-mono text-[0.32em] uppercase tracking-[0.18em] align-top text-[var(--color-ink-2)]">
                0G
              </span>
            </p>
          ) : null}
        </div>
        <Link
          href={explorerAddrUrl(agentAddress)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 self-start font-mono text-[12.5px] uppercase tracking-[0.22em] text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
        >
          {shortAddress(agentAddress, 10, 8)} ↗
        </Link>
      </section>

      <section className="grid gap-3 rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-paper)] px-6 py-7 sm:px-9">
        <span className="kicker">TRANSACTIONS · v2</span>
        <p className="max-w-[60ch] text-[15.5px] leading-[1.6] text-[var(--color-ink-2)]">
          Transaction history arrives in v2 with sandbox state and the action surfaces. For now the
          console is read-only: identity, memory, activity, balance. Sends and swaps stay in the CLI
          and Telegram surfaces.
        </p>
      </section>
    </div>
  )
}
