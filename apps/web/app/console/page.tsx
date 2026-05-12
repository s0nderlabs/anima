'use client'

import { useSiwe } from '@/components/SiweContext'
import { AgentList } from '@/components/console/AgentList'
import { ConnectGate } from '@/components/console/ConnectGate'
import { motion } from 'framer-motion'

const REVEAL_EASE = [0.22, 1, 0.36, 1] as const

export default function ConsoleHome() {
  const siwe = useSiwe()

  return (
    <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 pb-32 pt-28 sm:px-8 sm:pt-32">
      {siwe.status === 'loading' ? (
        // Holds layout while /api/auth/me resolves so the connect gate
        // doesn't flash for already-authed operators on hard refresh.
        <div className="min-h-[60vh]" aria-hidden />
      ) : siwe.status === 'authenticated' ? (
        <>
          <header className="grid gap-3 pb-10">
            <motion.h1
              initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.8, ease: REVEAL_EASE }}
              className="font-display font-light leading-[1.02] tracking-tight text-[var(--color-ink)]"
              style={{
                fontSize: 'clamp(38px, 4.6vw, 68px)',
                fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
              }}
            >
              Your agents.
            </motion.h1>
          </header>
          <AgentList />
        </>
      ) : (
        <div className="grid min-h-[60vh] place-items-center">
          <ConnectGate />
        </div>
      )}
    </div>
  )
}
