'use client'

import { useSiwe } from '@/components/SiweContext'
import { zgMainnet } from '@/lib/chain/chain'
import {
  type AgentChainMeta,
  type AgentSummary,
  getAgentChainMetaByTokenId,
  getAgentsByOwner,
} from '@/lib/chain/inft'
import { getLabelByAgentEoa } from '@/lib/chain/sann'
import { formatRelativeTime, shortAddress } from '@/lib/format'
import { motion } from 'framer-motion'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { usePublicClient } from 'wagmi'

type ActivityTokens = {
  syncCount: number
  syncWord: 'sync' | 'syncs'
  aliveValue: string // e.g. "16d", "1d", "today"
}

function buildActivityTokens(meta: AgentChainMeta): ActivityTokens {
  const now = Math.floor(Date.now() / 1000)
  const spanSeconds = Math.max(1, now - meta.firstSyncAt)
  const days = spanSeconds / 86400
  const aliveValue = days < 1 ? 'today' : days < 1.5 ? '1d' : `${Math.round(days)}d`
  return {
    syncCount: meta.syncCount,
    syncWord: meta.syncCount === 1 ? 'sync' : 'syncs',
    aliveValue,
  }
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ready'
      agents: AgentSummary[]
      labels: Map<bigint, string>
      meta: Map<bigint, AgentChainMeta>
    }
  | { kind: 'error'; message: string }

const POLL_INTERVAL_MS = 30_000
const TICK_INTERVAL_MS = 15_000

export function AgentList() {
  // Prefer the SIWE-session address: it's stable across wallet reconnects.
  const siwe = useSiwe()
  const address = siwe.address
  // Always read against 0G mainnet regardless of wallet's connected chain.
  const client = usePublicClient({ chainId: zgMainnet.id })
  const [state, setState] = useState<LoadState>({ kind: 'idle' })
  // Forces re-render so the relative-time labels recompute without re-fetching.
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!address || !client) {
      setState({ kind: 'idle' })
      return
    }
    let alive = true
    let isInitial = true
    setState({ kind: 'loading' })

    async function load() {
      try {
        const agents = await getAgentsByOwner(client!, address as Address)
        if (!alive) return
        const tokenIds = agents.map(a => a.tokenId)
        const [meta, labelByEoa] = await Promise.all([
          getAgentChainMetaByTokenId(client!, tokenIds).catch(
            () => new Map<bigint, AgentChainMeta>(),
          ),
          getLabelByAgentEoa(client!).catch(() => new Map<string, string>()),
        ])
        if (!alive) return
        const labels = new Map<bigint, string>()
        for (const [tid, m] of meta) {
          const label = labelByEoa.get(m.agentEoa.toLowerCase())
          if (label) labels.set(tid, label)
        }
        setState({ kind: 'ready', agents, labels, meta })
      } catch (err) {
        if (!alive) return
        // On background polls, keep prior state visible instead of flipping to error.
        if (isInitial) setState({ kind: 'error', message: (err as Error).message })
      } finally {
        isInitial = false
      }
    }

    void load()
    const poll = setInterval(() => {
      if (!alive) return
      void load()
    }, POLL_INTERVAL_MS)
    return () => {
      alive = false
      clearInterval(poll)
    }
  }, [address, client])

  // Wall-clock tick so "X ago" strings stay fresh between data refetches.
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), TICK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  const sortedAgents = useMemo(() => {
    if (state.kind !== 'ready') return [] as AgentSummary[]
    const meta = state.meta
    // Dormant agents (no sync events) fall to the bottom; mint-order (tokenId asc) within each group.
    return [...state.agents].sort((a, b) => {
      const aDormant = !meta.has(a.tokenId)
      const bDormant = !meta.has(b.tokenId)
      if (aDormant !== bDormant) return aDormant ? 1 : -1
      return a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0
    })
  }, [state])

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
      <motion.p
        initial={{ opacity: 0, y: 12, filter: 'blur(4px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.7, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
        className="text-[13px] text-[var(--color-ink-3)]"
      >
        {state.agents.length} agent{state.agents.length === 1 ? '' : 's'} anchored on 0G Chain.
      </motion.p>
      <ul className="mt-4 divide-y divide-[var(--color-border)]">
        {sortedAgents.map((agent, i) => {
          const label = state.labels.get(agent.tokenId)
          const meta = state.meta.get(agent.tokenId)
          const agentEoa = meta?.agentEoa
          const primaryName = label ? `${label}.anima.0g` : `Agent #${agent.tokenId.toString()}`
          const nowSec = Math.floor(Date.now() / 1000)
          const lastSyncSecondsAgo = meta ? nowSec - meta.lastSyncAt : null
          const lastSyncToken = meta ? formatRelativeTime(lastSyncSecondsAgo ?? 0) : null
          // formatRelativeTime returns "1h ago" / "12d ago"; split into value + unit-word.
          const [lastSyncValue, lastSyncWord] = lastSyncToken
            ? (lastSyncToken.split(' ') as [string, string])
            : [null, null]
          const isFresh = lastSyncSecondsAgo !== null && lastSyncSecondsAgo < 86_400
          const activity = meta ? buildActivityTokens(meta) : null
          return (
            <motion.li
              key={agent.tokenId.toString()}
              initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.7, delay: 0.16 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
            >
              <Link
                href={`/console/${agent.tokenId.toString()}`}
                className="group grid grid-cols-[1fr_auto] items-center gap-6 py-7 sm:gap-8"
              >
                <div className="grid gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span
                      className={
                        label
                          ? 'font-display text-[20px] font-light tracking-tight text-[var(--color-ink)]'
                          : meta
                            ? 'text-[13px] font-medium tracking-tight text-[var(--color-ink)]'
                            : 'text-[13px] font-medium tracking-tight text-[var(--color-ink-3)]'
                      }
                      style={
                        label
                          ? { fontVariationSettings: '"opsz" 60, "SOFT" 30, "WONK" 0' }
                          : undefined
                      }
                    >
                      {primaryName}
                    </span>
                    {lastSyncValue && lastSyncWord ? (
                      <span className="font-mono text-[11.5px]">
                        <span
                          aria-hidden
                          className={
                            isFresh ? 'text-[var(--color-ink-2)]' : 'text-[var(--color-ink-3)]'
                          }
                        >
                          ●
                        </span>{' '}
                        <span className="text-[var(--color-ink-2)]">{lastSyncValue}</span>{' '}
                        <span className="text-[var(--color-ink-3)]">{lastSyncWord}</span>
                      </span>
                    ) : null}
                  </div>
                  {agentEoa ? (
                    <p className="font-mono text-[13.5px] text-[var(--color-ink)]">
                      {shortAddress(agentEoa, 10, 6)}
                    </p>
                  ) : null}
                  {activity ? (
                    <p className="font-mono text-[12px] text-[var(--color-ink-3)]">
                      <span className="text-[var(--color-ink)]">{activity.syncCount}</span>{' '}
                      {activity.syncWord} · alive{' '}
                      <span className="text-[var(--color-ink-2)]">{activity.aliveValue}</span>
                    </p>
                  ) : null}
                  {!meta ? (
                    <p className="font-mono text-[12px] text-[var(--color-ink-3)]">
                      not yet anchored · awaiting first sync
                    </p>
                  ) : null}
                </div>
                <span
                  className={
                    meta
                      ? 'text-[13px] text-[var(--color-ink-2)] transition group-hover:text-[var(--color-ink)]'
                      : 'text-[13px] text-[var(--color-ink-3)] transition group-hover:text-[var(--color-ink-2)]'
                  }
                  aria-hidden
                >
                  Open{' '}
                  <span className="inline-block transition-transform group-hover:translate-x-0.5">
                    →
                  </span>
                </span>
              </Link>
            </motion.li>
          )
        })}
      </ul>
    </div>
  )
}
