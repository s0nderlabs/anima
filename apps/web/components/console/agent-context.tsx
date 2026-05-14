'use client'

import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { Address, Hex } from 'viem'

export type UnlockedKeys = {
  agentPrivkey: Hex
  memoryKey: CryptoKey
  unlockedAt: number
  /** PROFILE scope key, derived on-demand via a second operator signature. */
  profileKey?: CryptoKey
}

type AgentContextValue = {
  tokenId: bigint
  owner: Address | null
  setOwner: (a: Address) => void
  subname: string | null
  setSubname: (s: string | null) => void
  agentEOA: Address | null
  setAgentEOA: (a: Address | null) => void
  unlocked: UnlockedKeys | null
  setUnlocked: (k: UnlockedKeys) => void
  setProfileKey: (k: CryptoKey) => void
  clearUnlocked: () => void
}

const AgentContext = createContext<AgentContextValue | null>(null)

export function AgentContextProvider({
  tokenId,
  children,
}: {
  tokenId: bigint
  children: ReactNode
}) {
  const [owner, setOwnerState] = useState<Address | null>(null)
  const [subname, setSubnameState] = useState<string | null>(null)
  const [agentEOA, setAgentEOAState] = useState<Address | null>(null)
  const [unlocked, setUnlockedState] = useState<UnlockedKeys | null>(null)

  const setOwner = useCallback((a: Address) => setOwnerState(a), [])
  const setSubname = useCallback((s: string | null) => setSubnameState(s), [])
  const setAgentEOA = useCallback((a: Address | null) => setAgentEOAState(a), [])
  const setUnlocked = useCallback((k: UnlockedKeys) => setUnlockedState(k), [])
  const setProfileKey = useCallback(
    (k: CryptoKey) => setUnlockedState(prev => (prev ? { ...prev, profileKey: k } : prev)),
    [],
  )
  const clearUnlocked = useCallback(() => setUnlockedState(null), [])

  const value = useMemo<AgentContextValue>(
    () => ({
      tokenId,
      owner,
      setOwner,
      subname,
      setSubname,
      agentEOA,
      setAgentEOA,
      unlocked,
      setUnlocked,
      setProfileKey,
      clearUnlocked,
    }),
    [
      tokenId,
      owner,
      setOwner,
      subname,
      setSubname,
      agentEOA,
      setAgentEOA,
      unlocked,
      setUnlocked,
      setProfileKey,
      clearUnlocked,
    ],
  )

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export function useAgentContext(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgentContext requires AgentContextProvider')
  return ctx
}
