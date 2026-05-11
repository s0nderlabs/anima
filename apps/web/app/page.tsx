import { Navbar } from '@/components/Navbar'
import { Footer } from '@/components/Footer'
import { Hero } from '@/components/sections/Hero'
import { Section2 } from '@/components/sections/Section2'
import { Section3 } from '@/components/sections/Section3'
import { Section4 } from '@/components/sections/Section4'

export const metadata = {
  title: 'anima · first fully on-chain sovereign agent harness on 0G',
  description:
    'Identity on 0G Chain, brain on 0G Compute, memory on 0G Storage, harness on 0G Sandbox. Close the laptop, the agent survives.',
}

export default function LandingPage() {
  return (
    <main className="relative min-h-screen bg-[var(--color-cream)] text-[var(--color-ink)]">
      <Navbar />
      <Hero />
      <Section2 />
      <Section3 />
      <Section4 />
      <Footer />
    </main>
  )
}
