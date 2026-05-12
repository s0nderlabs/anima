'use client'

import {
  ANIMA_AGENT_NFT_ADDRESS,
  explorerAddrUrl,
  explorerTokenUrl,
  explorerTxUrl,
  zgMainnet,
} from '@/lib/chain/chain'
import { type SlotEntry, fetchSlots, fetchTransferHistory } from '@/lib/chain/inft'
import { shortAddress, shortHash } from '@/lib/format'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { Address, Hex } from 'viem'
import { usePublicClient } from 'wagmi'

type Transfer = {
  from: Address
  to: Address
  blockNumber: bigint
  txHash: Hex
}

const ALWAYS_DELAY = 0.12

export function IdentityPanel({ tokenId }: { tokenId: bigint }) {
  const client = usePublicClient({ chainId: zgMainnet.id })
  const [slots, setSlots] = useState<SlotEntry[] | null>(null)
  const [transfers, setTransfers] = useState<Transfer[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!client) return
    let alive = true
    Promise.all([fetchSlots(client, tokenId), fetchTransferHistory(client, tokenId, 5)])
      .then(([s, t]) => {
        if (!alive) return
        setSlots(s)
        setTransfers(t)
      })
      .catch((err: Error) => {
        if (!alive) return
        setError(err.message)
      })
    return () => {
      alive = false
    }
  }, [client, tokenId])

  return (
    <div className="grid gap-12 pt-6 sm:gap-16">
      <SlotTable slots={slots} error={error} />
      <TransferList transfers={transfers} />
      <ContractCard tokenId={tokenId} />
    </div>
  )
}

function SlotTable({ slots, error }: { slots: SlotEntry[] | null; error: string | null }) {
  return (
    <section className="grid gap-6">
      <div>
        <h2 className="font-display text-[clamp(24px,2.4vw,34px)] font-light leading-[1.1] tracking-tight text-[var(--color-ink)]">
          Data anchors
        </h2>
        <p className="mt-2 max-w-[60ch] text-[14px] leading-[1.55] text-[var(--color-ink-2)]">
          Six slots on 0G Chain. Each is a hash that points at an encrypted blob on 0G Storage.
        </p>
      </div>
      {error ? (
        <p className="text-[15px] leading-[1.55] text-[var(--color-ink-2)]">
          Could not read slot table: {error}
        </p>
      ) : (
        <div className="grid divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)]">
          {(slots ?? Array.from({ length: 6 }).map(() => null)).map((slot, i) => (
            <SlotRow key={slot?.name ?? `placeholder-${i}`} slot={slot} index={i} />
          ))}
        </div>
      )}
    </section>
  )
}

function SlotRow({ slot, index }: { slot: SlotEntry | null; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: ALWAYS_DELAY + index * 0.04, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="grid grid-cols-[minmax(160px,1fr)_minmax(0,2fr)_auto] items-center gap-4 px-5 py-4 sm:gap-8 sm:px-7"
    >
      {slot ? (
        <>
          <div>
            <p className="text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
              {slot.name}
            </p>
            <p className="mt-1 text-[13px] leading-[1.4] text-[var(--color-ink-3)]">
              {slot.isBootstrap ? 'awaiting first sync' : 'anchored'}
            </p>
          </div>
          <p className="font-mono text-[12.5px] text-[var(--color-ink)]">
            {slot.isBootstrap ? (
              <span className="text-[var(--color-ink-3)]">{shortHash(slot.hash)}</span>
            ) : (
              shortHash(slot.hash, 12, 8)
            )}
          </p>
          {slot.isBootstrap ? (
            <span className="text-[12.5px] text-[var(--color-ink-3)]">placeholder</span>
          ) : (
            <Link
              href={`https://chainscan.0g.ai/token/${ANIMA_AGENT_NFT_ADDRESS}`}
              target="_blank"
              rel="noreferrer"
              className="text-[12.5px] text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
            >
              chain ↗
            </Link>
          )}
        </>
      ) : (
        <>
          <span className="text-[14px] text-[var(--color-ink-3)]">loading…</span>
          <span className="font-mono text-[12.5px] text-[var(--color-ink-3)]">0x…</span>
          <span className="text-[12.5px] text-[var(--color-ink-3)]">—</span>
        </>
      )}
    </motion.div>
  )
}

function TransferList({ transfers }: { transfers: Transfer[] | null }) {
  if (!transfers) return null
  if (transfers.length === 0) {
    return (
      <section className="grid gap-3">
        <h2 className="font-display text-[clamp(20px,2vw,26px)] font-light leading-[1.15] tracking-tight text-[var(--color-ink)]">
          Transfers
        </h2>
        <p className="text-[15px] leading-[1.6] text-[var(--color-ink-2)]">
          Never moved hands. Still with its first operator.
        </p>
      </section>
    )
  }
  return (
    <section className="grid gap-5">
      <h2 className="font-display text-[clamp(20px,2vw,26px)] font-light leading-[1.15] tracking-tight text-[var(--color-ink)]">
        Transfers <span className="text-[var(--color-ink-3)]">· last {transfers.length}</span>
      </h2>
      <div className="grid divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)]">
        {transfers.map(t => (
          <div
            key={t.txHash}
            className="grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4 sm:gap-8 sm:px-7"
          >
            <div className="grid gap-1">
              <p className="font-mono text-[13px] text-[var(--color-ink)]">
                {shortAddress(t.from)} <span className="text-[var(--color-ink-3)]">→</span>{' '}
                {shortAddress(t.to)}
              </p>
              <p className="font-mono text-[12px] text-[var(--color-ink-2)]">
                block {t.blockNumber.toString()}
              </p>
            </div>
            <Link
              href={explorerTxUrl(t.txHash)}
              target="_blank"
              rel="noreferrer"
              className="text-[12.5px] text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
            >
              tx ↗
            </Link>
          </div>
        ))}
      </div>
    </section>
  )
}

function ContractCard({ tokenId }: { tokenId: bigint }) {
  return (
    <section className="grid gap-4">
      <h2 className="font-display text-[clamp(20px,2vw,26px)] font-light leading-[1.15] tracking-tight text-[var(--color-ink)]">
        Contract
      </h2>
      <div className="grid gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)] px-5 py-5 sm:grid-cols-[1fr_auto] sm:items-center sm:px-7">
        <div className="grid gap-1.5">
          <p className="font-mono text-[13px] text-[var(--color-ink)]">{ANIMA_AGENT_NFT_ADDRESS}</p>
          <p className="text-[12.5px] text-[var(--color-ink-2)]">
            0G Chain · ERC-7857 · CREATE2 deterministic
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href={explorerAddrUrl(ANIMA_AGENT_NFT_ADDRESS)}
            target="_blank"
            rel="noreferrer"
            className="text-[12.5px] text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
          >
            contract ↗
          </Link>
          <Link
            href={explorerTokenUrl(ANIMA_AGENT_NFT_ADDRESS, tokenId)}
            target="_blank"
            rel="noreferrer"
            className="text-[12.5px] text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
          >
            token #{tokenId.toString()} ↗
          </Link>
        </div>
      </div>
    </section>
  )
}
