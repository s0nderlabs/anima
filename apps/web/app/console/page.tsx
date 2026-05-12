'use client'

import { useSiwe } from '@/components/SiweContext'
import { AgentList } from '@/components/console/AgentList'
import { ConnectGate } from '@/components/console/ConnectGate'

export default function ConsoleHome() {
  const siwe = useSiwe()
  const authed = siwe.status === 'authenticated'

  return (
    <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 pb-32 pt-28 sm:px-8 sm:pt-32">
      {authed ? (
        <>
          <header className="grid gap-3 pb-10">
            <h1
              className="font-display font-light leading-[1.02] tracking-tight text-[var(--color-ink)]"
              style={{
                fontSize: 'clamp(38px, 4.6vw, 68px)',
                fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
              }}
            >
              Your agents.
            </h1>
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
