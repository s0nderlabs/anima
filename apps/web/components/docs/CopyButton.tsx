'use client'

import { useState } from 'react'

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        } catch {
          // ignore
        }
      }}
      aria-label={copied ? 'Copied' : 'Copy code'}
      className="absolute right-2 top-[13px] inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-[var(--color-ink-3)] transition hover:border-[var(--color-border)] hover:bg-[var(--color-cream)] hover:text-[var(--color-ink)]"
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3.5 8.5l3 3 6-6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect
            x="5"
            y="5"
            width="9"
            height="9"
            rx="1.25"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
          />
          <path
            d="M11 5V3.25A1.25 1.25 0 009.75 2H3.25A1.25 1.25 0 002 3.25v6.5A1.25 1.25 0 003.25 11H5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      )}
    </button>
  )
}
