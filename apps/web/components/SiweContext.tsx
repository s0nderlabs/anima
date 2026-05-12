'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useSiweAuth, type SiweAuth } from '@/lib/use-siwe'

const SiweContext = createContext<SiweAuth | null>(null)

export function SiweProvider({ children }: { children: ReactNode }) {
  const auth = useSiweAuth()
  return <SiweContext.Provider value={auth}>{children}</SiweContext.Provider>
}

export function useSiwe(): SiweAuth {
  const ctx = useContext(SiweContext)
  if (!ctx) throw new Error('useSiwe requires SiweProvider')
  return ctx
}
