'use client'

import { useConnectModal } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { useSiwe } from '@/components/SiweContext'
import { shortAddress } from '@/lib/format'

const PILL_DARK =
  'inline-flex items-center gap-1.5 rounded-full bg-[var(--color-ink)] px-5 py-2.5 text-[13.5px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(16,15,9,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-wait disabled:opacity-70 disabled:hover:translate-y-0 disabled:hover:scale-100'

const PILL_GHOST =
  'inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-cream)] px-5 py-2.5 text-[13.5px] font-medium tracking-tight text-[var(--color-ink)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99]'

export function ConsoleNavbar() {
  const { openConnectModal } = useConnectModal()
  const { isConnected, address } = useAccount()
  const siwe = useSiwe()

  let right: React.ReactNode
  if (siwe.status === 'authenticated' && siwe.address) {
    right = (
      <button
        type="button"
        onClick={() => void siwe.signOut()}
        className={PILL_GHOST}
        title={`${siwe.address} · click to disconnect`}
      >
        {shortAddress(siwe.address, 6, 4)}
      </button>
    )
  } else if (siwe.status === 'signing') {
    right = (
      <button type="button" disabled className={PILL_DARK}>
        Signing…
      </button>
    )
  } else if (isConnected && address && siwe.status === 'unauthenticated') {
    right = (
      <button
        type="button"
        onClick={() => void siwe.signIn()}
        className={PILL_DARK}
      >
        Sign in <span aria-hidden>→</span>
      </button>
    )
  } else {
    right = (
      <button
        type="button"
        onClick={() => openConnectModal?.()}
        className={PILL_DARK}
        disabled={siwe.status === 'loading'}
      >
        Connect <span aria-hidden>→</span>
      </button>
    )
  }

  return (
    <header className="fixed inset-x-0 top-0 z-50 pt-5 sm:pt-6">
      <div className="mx-auto flex h-[56px] w-full max-w-[var(--container-wrap)] items-center justify-between px-6 sm:px-8">
        <Link
          href="/"
          className="font-wordmark text-[24px] leading-none tracking-[-0.02em] text-[var(--color-ink)]"
          aria-label="anima home"
        >
          anima<span className="text-[var(--color-ink-3)]"> · console</span>
        </Link>
        <nav className="hidden items-center gap-7 md:flex">
          <Link
            href="/#section-layers"
            className="text-[14px] font-medium tracking-[-0.005em] text-[var(--color-ink)] transition-colors duration-200 hover:text-[var(--color-ink-2)]"
          >
            Architecture
          </Link>
          <Link
            href="/docs"
            className="text-[14px] font-medium tracking-[-0.005em] text-[var(--color-ink)] transition-colors duration-200 hover:text-[var(--color-ink-2)]"
          >
            Docs
          </Link>
        </nav>
        <div className="flex items-center">{right}</div>
      </div>
    </header>
  )
}
