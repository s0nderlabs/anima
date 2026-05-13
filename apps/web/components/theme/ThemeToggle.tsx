'use client'

import { motion } from 'framer-motion'
import { useEffect, useId, useState } from 'react'
import { useTheme, type ThemeMode } from './ThemeProvider'

type Option = {
  value: ThemeMode
  label: string
  ariaLabel: string
  Icon: (props: { className?: string }) => React.JSX.Element
}

const OPTIONS: Option[] = [
  { value: 'light', label: 'Light', ariaLabel: 'Use light theme', Icon: SunIcon },
  { value: 'system', label: 'Auto', ariaLabel: 'Match system theme', Icon: AutoIcon },
  { value: 'dark', label: 'Dark', ariaLabel: 'Use dark theme', Icon: MoonIcon },
]

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const groupId = useId()

  // Avoid hydration mismatch: render a neutral state until after mount, then
  // swap to the real selection.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="relative inline-flex w-fit items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-paper)] p-1 shadow-[0_2px_6px_-3px_rgba(16,15,9,0.12)]"
    >
      {OPTIONS.map(opt => {
        const isActive = mounted && theme === opt.value
        return (
          <button
            key={opt.value}
            role="radio"
            aria-checked={isActive}
            aria-label={opt.ariaLabel}
            onClick={() => setTheme(opt.value)}
            className={`relative z-10 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium tracking-tight transition-colors duration-200 ${
              isActive
                ? 'text-[var(--color-cream)]'
                : 'text-[var(--color-ink-2)] hover:text-[var(--color-ink)]'
            }`}
          >
            {isActive ? (
              <motion.span
                layoutId={`theme-pill-${groupId}`}
                className="absolute inset-0 -z-10 rounded-full bg-[var(--color-ink)] shadow-[0_8px_18px_-10px_rgba(16,15,9,0.45)]"
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              />
            ) : null}
            <opt.Icon className="h-3.5 w-3.5" />
            <span>{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function SunIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v1.5" />
      <path d="M12 19.5V21" />
      <path d="M4.22 4.22l1.06 1.06" />
      <path d="M18.72 18.72l1.06 1.06" />
      <path d="M3 12h1.5" />
      <path d="M19.5 12H21" />
      <path d="M4.22 19.78l1.06-1.06" />
      <path d="M18.72 5.28l1.06-1.06" />
    </svg>
  )
}

function MoonIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z" />
    </svg>
  )
}

function AutoIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </svg>
  )
}
