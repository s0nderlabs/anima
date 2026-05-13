import { MotionProvider } from '@/components/MotionProvider'
import { PaperNoise } from '@/components/PaperNoise'
import type { Metadata, Viewport } from 'next'
import { Fraunces, Geist_Mono, Instrument_Serif, Outfit } from 'next/font/google'
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
  themeColor: '#f6f1e6',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${instrumentSerif.variable} ${outfit.variable} ${geistMono.variable} ${calSans.variable}`}
    >
      <body>
        <Providers>
          <MotionProvider>
            <PaperNoise />
            {children}
          </MotionProvider>
        </Providers>
      </body>
    </html>
  )
}
