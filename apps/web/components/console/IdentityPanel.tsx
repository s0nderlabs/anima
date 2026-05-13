'use client'

import {
  ANIMA_AGENT_NFT_ADDRESS,
  INTELLIGENT_DATA_SLOTS,
  explorerAddrUrl,
  explorerTokenUrl,
  explorerTxUrl,
  zgMainnet,
} from '@/lib/chain/chain'
import {
  type SlotEntry,
  fetchAnchorHistory,
  fetchSlots,
  fetchTransferHistory,
} from '@/lib/chain/inft'
import { shortAddress, shortHash } from '@/lib/format'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
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
  // Per-slot most-recent Updated tx hash. Slot name → tx hash.
  const [slotTx, setSlotTx] = useState<Map<string, Hex>>(new Map())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!client) return
    let alive = true
    Promise.all([
      fetchSlots(client, tokenId),
      fetchTransferHistory(client, tokenId, 5),
      fetchAnchorHistory(client, tokenId, 200),
    ])
      .then(([s, t, anchors]) => {
        if (!alive) return
        setSlots(s)
        setTransfers(t)
        // Walk anchor events newest-first; first event mentioning a slot index
        // wins (that's the most-recent Updated tx that anchored that slot).
        const txBySlot = new Map<string, Hex>()
        outer: for (const a of anchors) {
          for (const idx of a.slots) {
            const name = INTELLIGENT_DATA_SLOTS[Number(idx)]
            if (name && !txBySlot.has(name)) txBySlot.set(name, a.txHash)
          }
          if (txBySlot.size === INTELLIGENT_DATA_SLOTS.length) break outer
        }
        setSlotTx(txBySlot)
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
      <SlotTable slots={slots} slotTx={slotTx} error={error} />
      <ContractCard tokenId={tokenId} />
      <TransferList transfers={transfers} />
    </div>
  )
}

function SlotTable({
  slots,
  slotTx,
  error,
}: {
  slots: SlotEntry[] | null
  slotTx: Map<string, Hex>
  error: string | null
}) {
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
            <SlotRow
              key={slot?.name ?? `placeholder-${i}`}
              slot={slot}
              index={i}
              txHash={slot ? (slotTx.get(slot.name) ?? null) : null}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function SlotRow({
  slot,
  index,
  txHash,
}: {
  slot: SlotEntry | null
  index: number
  txHash: Hex | null
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: ALWAYS_DELAY + index * 0.04, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="grid grid-cols-[minmax(160px,1fr)_minmax(0,2fr)_minmax(96px,auto)] items-center gap-4 px-5 py-4 sm:gap-8 sm:px-7"
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
          <div className="flex items-center gap-2">
            <p className="font-mono text-[12.5px] text-[var(--color-ink)]">
              {slot.isBootstrap ? (
                <span className="text-[var(--color-ink-3)]">{shortHash(slot.hash, 12, 8)}</span>
              ) : (
                shortHash(slot.hash, 12, 8)
              )}
            </p>
            <CopyButton value={slot.hash} />
          </div>
          {slot.isBootstrap ? (
            <span className="text-[12.5px] text-[var(--color-ink-3)]">placeholder</span>
          ) : txHash ? (
            <Link
              href={explorerTxUrl(txHash)}
              target="_blank"
              rel="noreferrer"
              className="text-[12.5px] text-[var(--color-ink-2)] transition hover:text-[var(--color-ink)]"
            >
              chain ↗
            </Link>
          ) : (
            <span className="text-[12.5px] text-[var(--color-ink-3)]">—</span>
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

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  function handleCopy() {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy hash'}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--color-ink-3)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_4%,transparent)] hover:text-[var(--color-ink)]"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-[12px] w-[12px]"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-[12px] w-[12px]"
    >
      <path d="M3 8.5l3 3 7-7" />
    </svg>
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
