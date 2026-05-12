'use client'

import { shortAddress } from '@/lib/format'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'

const PILL_CLASS =
  'inline-flex items-center gap-1.5 rounded-full bg-[var(--color-ink)] px-5 py-2.5 text-[13.5px] font-medium tracking-tight text-[var(--color-cream)] shadow-[0_18px_40px_-22px_rgba(16,15,9,0.7)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99]'

const PILL_GHOST =
  'inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-cream)] px-5 py-2.5 text-[13.5px] font-medium tracking-tight text-[var(--color-ink)] transition-transform hover:-translate-y-0.5 hover:scale-[1.01] active:scale-[0.99]'

export function ConsoleNav() {
  return (
    <div className="sticky top-[72px] z-30 -mx-6 mb-10 border-b border-[var(--color-border)] bg-[var(--color-cream)]/85 px-6 backdrop-blur-md sm:-mx-8 sm:px-8">
      <div className="mx-auto flex h-[56px] w-full max-w-[var(--container-wrap)] items-center justify-between">
        <Link
          href="/console"
          className="font-wordmark text-[20px] leading-none tracking-[-0.02em] text-[var(--color-ink)]"
        >
          anima · console
        </Link>
        <ConnectButton.Custom>
          {({ account, chain, openAccountModal, openConnectModal, mounted }) => {
            const ready = mounted
            const connected = ready && account && chain
            return (
              <div
                {...(!ready && {
                  'aria-hidden': true,
                  style: {
                    opacity: 0,
                    pointerEvents: 'none',
                    userSelect: 'none',
                  },
                })}
              >
                {!connected ? (
                  <button type="button" onClick={openConnectModal} className={PILL_CLASS}>
                    Connect <span aria-hidden>→</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={openAccountModal}
                    className={PILL_GHOST}
                    title={account.address}
                  >
                    {shortAddress(account.address, 6, 4)}
                  </button>
                )}
              </div>
            )
          }}
        </ConnectButton.Custom>
      </div>
    </div>
  )
}
