'use client'

import { useSiwe } from '@/components/SiweContext'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useEffect, useRef } from 'react'
import { useAccount } from 'wagmi'

const PILL_DARK =
  'rounded-full bg-[var(--color-ink)] px-7 py-3.5 text-[15px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(16,15,9,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-wait disabled:opacity-70 disabled:hover:translate-y-0 disabled:hover:scale-100'

export function ConnectGate() {
  const { openConnectModal } = useConnectModal()
  const { isConnected, address } = useAccount()
  const siwe = useSiwe()
  const autoOpenedRef = useRef(false)

  // Auto-open the wallet modal on first mount when no wallet is connected.
  // This makes /console feel like a gate — opening it IS the connect prompt.
  useEffect(() => {
    if (autoOpenedRef.current) return
    if (isConnected) return
    if (siwe.status !== 'unauthenticated') return
    if (!openConnectModal) return
    autoOpenedRef.current = true
    openConnectModal()
  }, [isConnected, siwe.status, openConnectModal])

  let primary: React.ReactNode
  if (siwe.status === 'signing') {
    primary = (
      <button type="button" disabled className={PILL_DARK}>
        Signing…
      </button>
    )
  } else if (isConnected && address && siwe.status === 'unauthenticated') {
    primary = (
      <button type="button" onClick={() => void siwe.signIn()} className={PILL_DARK}>
        Sign in <span aria-hidden>→</span>
      </button>
    )
  } else {
    primary = (
      <button
        type="button"
        onClick={() => openConnectModal?.()}
        className={PILL_DARK}
        disabled={siwe.status === 'loading'}
      >
        Connect wallet <span aria-hidden>→</span>
      </button>
    )
  }

  return (
    <div className="grid gap-6">
      <div>
        <h2
          className="max-w-[18ch] font-display font-light leading-[1.05] tracking-tight text-[var(--color-ink)]"
          style={{
            fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
            fontSize: 'clamp(34px, 4vw, 56px)',
          }}
        >
          Connect to see your agents.
        </h2>
        <p className="mt-3 max-w-[44ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
          Only you ever hold the key. The signature stays in your browser. Nothing leaves after.
        </p>
      </div>
      <div className="pt-2">{primary}</div>
      {siwe.error ? (
        <p className="font-mono text-[12.5px] text-[var(--color-ink-2)]">{siwe.error}</p>
      ) : null}
    </div>
  )
}
