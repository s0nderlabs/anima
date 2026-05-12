'use client'

import { useSiwe } from '@/components/SiweContext'
import { shortAddress } from '@/lib/format'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'

const PILL_DARK =
  'inline-flex items-center gap-1.5 rounded-full bg-[var(--color-ink)] px-5 py-2.5 text-[13.5px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(16,15,9,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-wait disabled:opacity-70 disabled:hover:translate-y-0 disabled:hover:scale-100'

const PILL_GHOST =
  'inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-cream)] px-5 py-2.5 text-[13.5px] font-medium tracking-tight text-[var(--color-ink)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99]'

export function ConsoleNavbar() {
  const { openConnectModal } = useConnectModal()
  const { isConnected, address } = useAccount()
  const siwe = useSiwe()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  let right: React.ReactNode
  if (siwe.status === 'loading') {
    // Invisible placeholder so the navbar doesn't flash "Connect" while
    // /api/auth/me is in flight on hard refresh for already-authed operators.
    right = (
      <span aria-hidden className={`${PILL_DARK} pointer-events-none invisible`}>
        Connect <span aria-hidden>→</span>
      </span>
    )
  } else if (siwe.status === 'authenticated' && siwe.address) {
    right = (
      <button
        type="button"
        onClick={() => setConfirmDisconnect(true)}
        className={PILL_GHOST}
        title={siwe.address}
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
      <button type="button" onClick={() => void siwe.signIn()} className={PILL_DARK}>
        Sign in <span aria-hidden>→</span>
      </button>
    )
  } else {
    right = (
      <button type="button" onClick={() => openConnectModal?.()} className={PILL_DARK}>
        Connect <span aria-hidden>→</span>
      </button>
    )
  }

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-50 bg-[var(--color-cream)] pt-5 sm:pt-6">
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
      {confirmDisconnect && siwe.address ? (
        <DisconnectDialog
          address={siwe.address}
          onClose={() => setConfirmDisconnect(false)}
          onConfirm={async () => {
            setConfirmDisconnect(false)
            await siwe.signOut()
          }}
        />
      ) : null}
    </>
  )
}

function DisconnectDialog({
  address,
  onClose,
  onConfirm,
}: {
  address: `0x${string}`
  onClose: () => void
  onConfirm: () => void | Promise<void>
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="disconnect-dialog-title"
      className="fixed inset-0 z-[100] flex items-center justify-center px-6"
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-[color-mix(in_oklab,var(--color-ink)_30%,transparent)] backdrop-blur-[2px]"
      />
      <div className="relative w-full max-w-[440px] rounded-xl border border-[var(--color-border)] bg-[var(--color-paper)] p-7 shadow-[0_50px_120px_-40px_rgba(16,15,9,0.5)]">
        <h2
          id="disconnect-dialog-title"
          className="font-display font-light text-[var(--color-ink)]"
          style={{
            fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0',
            fontSize: 'clamp(26px, 2.6vw, 32px)',
            lineHeight: 1.1,
            letterSpacing: '-0.01em',
          }}
        >
          Disconnect this wallet?
        </h2>
        <p className="font-body mt-3 max-w-[42ch] text-[14.5px] leading-[1.6] text-[var(--color-ink-2)]">
          You'll need to connect and sign again to see your agents. Decrypted memory in this tab is
          cleared.
        </p>
        <p className="font-mono mt-5 text-[13px] text-[var(--color-ink-3)]">
          {shortAddress(address, 6, 4)}
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-transparent px-5 py-2.5 text-[13.5px] font-medium tracking-tight text-[var(--color-ink-2)] transition-colors hover:text-[var(--color-ink)]"
          >
            Stay connected
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            className="rounded-full bg-[var(--color-ink)] px-5 py-2.5 text-[13.5px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(16,15,9,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99]"
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  )
}
