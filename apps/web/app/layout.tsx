import { MotionProvider } from '@/components/MotionProvider'
import { PaperNoise } from '@/components/PaperNoise'
import { THEME_STORAGE_KEY } from '@/components/theme/constants'
import { ThemeProvider } from '@/components/theme/ThemeProvider'
import { ThemeScript } from '@/components/theme/ThemeScript'
import type { Metadata, Viewport } from 'next'
import { Fraunces, Geist_Mono, Instrument_Serif, Outfit } from 'next/font/google'
import { cookies } from 'next/headers'
import localFont from 'next/font/local'
import { Providers } from './providers'
import './globals.css'

const fraunces = Fraunces({
  subsets: ['latin'],
  display: 'swap',
  axes: ['SOFT', 'WONK', 'opsz'],
  variable: '--font-fraunces',
})

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['italic', 'normal'],
  display: 'swap',
  variable: '--font-instrument-serif',
})

const outfit = Outfit({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-outfit',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-geist-mono',
})

const calSans = localFont({
  src: '../public/fonts/CalSans-Regular.woff2',
  weight: '400',
  display: 'swap',
  variable: '--font-cal-sans',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://anima.s0nderlabs.xyz'),
  title: 'anima · a fully sovereign agentic harness',
  description:
    'No host. No central operator. Fully on 0G. Identity, brain, memory, limbs, comms, and economy live on decentralized infrastructure. Mint once. Anima keeps running.',
  applicationName: 'anima',
  authors: [{ name: 's0nderlabs', url: 'https://x.com/s0nderlabs' }],
  keywords: [
    'anima',
    's0nderlabs',
    '0G',
    'sovereign agent',
    'AI agent',
    'iNFT',
    'ERC-7857',
    'TEE',
    'on-chain agent',
    'agentic harness',
  ],
  openGraph: {
    type: 'website',
    title: 'anima · a fully sovereign agentic harness',
    description: 'No host. No central operator. Fully on 0G. Mint once. Anima keeps running.',
    siteName: 'anima',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'anima · a fully sovereign agentic harness',
    description: 'No host. No central operator. Fully on 0G. Mint once. Anima keeps running.',
    creator: '@s0nderlabs',
  },
  alternates: {
    types: {
      'text/plain': [
        { url: '/llms.txt', title: 'llms.txt' },
        { url: '/llms-full.txt', title: 'llms-full.txt' },
      ],
    },
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f9f8f6' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0d0a' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read theme cookie server-side so the first byte of HTML carries the
  // right <html class>. Without this, dark-OS users with an explicit
  // light pick see a flash of dark: the @media (prefers-color-scheme: dark)
  // rule applies because no .light class is on <html> yet, the inline
  // script later adds the class but several paints (and the browser's
  // navigation theme-color background) have already rendered dark.
  // The cookie is mirrored from localStorage by ThemeProvider on mount.
  const cookieStore = await cookies()
  const cookieTheme = cookieStore.get(THEME_STORAGE_KEY)?.value
  const themeClass = cookieTheme === 'dark' || cookieTheme === 'light' ? cookieTheme : ''

  return (
    <html
      lang="en"
      className={`${themeClass} ${fraunces.variable} ${instrumentSerif.variable} ${outfit.variable} ${geistMono.variable} ${calSans.variable}`}
      data-theme-ssr={cookieTheme || 'unset'}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body>
        <ThemeProvider>
          <Providers>
            <MotionProvider>
              <PaperNoise />
              {children}
            </MotionProvider>
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  )
}
