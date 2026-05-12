import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { ConsoleNavbar } from '@/components/console/ConsoleNavbar'

export const metadata: Metadata = {
  title: 'console · anima',
  description:
    'Operator console for anima. Connect your wallet to view the agents you own. Memory and activity decrypt in your browser.',
}

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-screen bg-[var(--color-cream)] text-[var(--color-ink)]">
      <ConsoleNavbar />
      {children}
    </main>
  )
}
