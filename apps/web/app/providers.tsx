'use client'

import { RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from '@/lib/wagmi'
import { SiweProvider } from '@/components/SiweContext'

import '@rainbow-me/rainbowkit/styles.css'

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  const rkTheme = useMemo(
    () =>
      lightTheme({
        accentColor: '#100f09',
        accentColorForeground: '#f9f8f6',
        borderRadius: 'medium',
        fontStack: 'system',
        overlayBlur: 'small',
      }),
    [],
  )

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rkTheme} modalSize="compact">
          <SiweProvider>{children}</SiweProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
