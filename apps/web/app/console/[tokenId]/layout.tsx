'use client'

import { useSiwe } from '@/components/SiweContext'
import { AgentDetailHeader } from '@/components/console/AgentDetailHeader'
import { ConnectGate } from '@/components/console/ConnectGate'
import { AgentContextProvider, useAgentContext } from '@/components/console/agent-context'
import { readAgentEoa } from '@/lib/agent-eoa-cache'
import { zgMainnet } from '@/lib/chain/chain'
import { type AgentChainMeta, fetchOwner, getAgentChainMetaByTokenId } from '@/lib/chain/inft'
import { getLabelByAgentEoa } from '@/lib/chain/sann'
import { useRouter } from 'next/navigation'
import { type ReactNode, useEffect, useState } from 'react'
import { use as usePromise } from 'react'
import type { Address } from 'viem'
import { usePublicClient } from 'wagmi'

type Params = { tokenId: string }

export default function AgentDetailLayout(props: {
  children: ReactNode
  params: Promise<Params>
}) {
  const { tokenId: raw } = usePromise(props.params)
  const tokenId = BigInt(raw)
  return (
    <AgentContextProvider tokenId={tokenId}>
      <DetailShell tokenId={tokenId}>{props.children}</DetailShell>
    </AgentContextProvider>
  )
}

function DetailShell({ tokenId, children }: { tokenId: bigint; children: ReactNode }) {
  const router = useRouter()
  const siwe = useSiwe()
  const address = siwe.address
  const client = usePublicClient({ chainId: zgMainnet.id })
  const ctx = useAgentContext()
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<AgentChainMeta | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: ctx setters are stable
  useEffect(() => {
    // Hydrate cached agent EOA immediately, even before wagmi reconnects —
    // wagmi state can be empty after a hard navigation while SIWE is still
    // authenticated. Unlock flow will trigger reconnect on demand.
    if (!client) return
    const cached = readAgentEoa(tokenId)
    if (cached) {
      ctx.setAgentEOA(cached)
    }
    if (!address) return
    let alive = true

    fetchOwner(client, tokenId)
      .then(async owner => {
        if (!alive) return
        ctx.setOwner(owner as Address)
        if (owner.toLowerCase() !== address.toLowerCase()) {
          setError('You do not own this agent. Returning to the console.')
          setTimeout(() => router.replace('/console'), 1500)
          return
        }
        // Chain meta + subname registry scan in parallel (both best-effort).
        const [metaResult, labelByEoaResult] = await Promise.allSettled([
          getAgentChainMetaByTokenId(client, [tokenId]),
          getLabelByAgentEoa(client),
        ])
        if (!alive) return

        let resolvedEoa: Address | null = null
        if (metaResult.status === 'fulfilled') {
          const m = metaResult.value.get(tokenId) ?? null
          setMeta(m)
          if (m) resolvedEoa = m.agentEoa
        }
        if (resolvedEoa && labelByEoaResult.status === 'fulfilled') {
          const label = labelByEoaResult.value.get(resolvedEoa.toLowerCase())
          if (label) ctx.setSubname(label)
        }
        if (resolvedEoa) ctx.setAgentEOA(resolvedEoa)
      })
      .catch((err: Error) => {
        if (!alive) return
        setError(`Could not read agent: ${err.message}`)
      })
    return () => {
      alive = false
    }
  }, [client, address, tokenId])

  return (
    <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 pb-32 pt-28 sm:px-8 sm:pt-32">
      {siwe.status !== 'authenticated' ? (
        <ConnectGate />
      ) : error ? (
        <div className="grid gap-3 pt-2">
          <span className="kicker">AGENT · ACCESS</span>
          <p className="text-[15.5px] leading-[1.6] text-[var(--color-ink-2)]">{error}</p>
        </div>
      ) : (
        <>
          <AgentDetailHeader
            tokenId={tokenId}
            subname={ctx.subname ?? null}
            agentEOA={ctx.agentEOA ?? null}
            meta={meta}
          />
          {children}
        </>
      )}
    </div>
  )
}
