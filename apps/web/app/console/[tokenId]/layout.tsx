'use client'

import { useSiwe } from '@/components/SiweContext'
import { AgentDetailHeader } from '@/components/console/AgentDetailHeader'
import { ConnectGate } from '@/components/console/ConnectGate'
import { AgentContextProvider, useAgentContext } from '@/components/console/agent-context'
import { readAgentEoa } from '@/lib/agent-eoa-cache'
import { ANIMA_AGENT_NFT_ADDRESS, zgMainnet } from '@/lib/chain/chain'
import { fetchOwner } from '@/lib/chain/inft'
import { findAgentSubnameForToken, listSubnamesClaimedBy } from '@/lib/chain/registrar'
import { useRouter } from 'next/navigation'
import { type ReactNode, useEffect, useState } from 'react'
import { use as usePromise } from 'react'
import type { Address } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'

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
  const { address } = useAccount()
  const client = usePublicClient({ chainId: zgMainnet.id })
  const ctx = useAgentContext()
  const siwe = useSiwe()
  const [error, setError] = useState<string | null>(null)

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
        // Reverse-lookup subname (best-effort, won't block render).
        try {
          const claimed = await listSubnamesClaimedBy(client, address as Address)
          if (claimed.length === 0) return
          const match = await findAgentSubnameForToken(
            client,
            claimed,
            ANIMA_AGENT_NFT_ADDRESS as Address,
            tokenId,
          )
          if (!alive || !match) return
          ctx.setSubname(match.label)
          ctx.setAgentEOA(match.agentEOA)
        } catch {
          // Best-effort only.
        }
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
            owner={ctx.owner ?? address ?? ''}
            subname={ctx.subname ?? null}
          />
          {children}
        </>
      )}
    </div>
  )
}
