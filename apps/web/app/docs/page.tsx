import Link from 'next/link'
import { Navbar } from '@/components/Navbar'
import { Footer } from '@/components/Footer'

export const metadata = {
  title: 'docs · anima',
  description: 'Install anima and run your first sovereign agent on 0G.',
}

const STEPS = [
  {
    label: '01',
    title: 'Install',
    body:
      'anima ships as a single bun-installable package. The CLI carries the full harness — runtime, gateway, plugins, brain wrapper, all of it.',
    code: 'bun add -g @s0nderlabs/anima',
  },
  {
    label: '02',
    title: 'Initialize',
    body:
      'Walk through the init wizard. anima mints an iNFT, generates an agent wallet, opens a compute envelope on 0G Compute, and anchors the seed memory partition to 0G Storage. One operator wallet signature secures the keystore.',
    code: 'anima init',
  },
  {
    label: '03',
    title: 'Chat',
    body:
      'Run anima with no args to drop into the TUI. The brain runs on 0G Compute (TeeML, GLM-5 by default). Every turn is attested, every memory write encrypted, every chain anchor verifiable.',
    code: 'anima',
  },
  {
    label: '04',
    title: 'Walk away',
    body:
      'Run `anima deploy` to lift the harness off your machine onto a 0G Sandbox enclave. The agent now lives on chain + storage + compute + sandbox — six layers, none of them yours. Pair via Telegram for ambient access.',
    code: 'anima deploy --target 0g-sandbox',
  },
]

export default function DocsPage() {
  return (
    <main className="relative min-h-screen bg-[var(--color-cream)] text-[var(--color-ink)]">
      <Navbar />
      <section className="mx-auto flex w-full max-w-[var(--container-narrow)] flex-col gap-12 px-6 pb-24 pt-32 sm:px-8">
        <header className="space-y-5">
          <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
            DOCS · QUICKSTART
          </span>
          <h1 className="font-display text-[clamp(40px,5vw,72px)] font-light leading-[1.04] tracking-[-0.018em]">
            Run your first <span className="font-italic-serif italic">sovereign</span> agent.
          </h1>
          <p className="max-w-xl text-[15px] leading-relaxed text-[var(--color-ink-2)]">
            Four steps. Each one writes something to chain. By the end your agent has an iNFT, a
            wallet, a brain envelope, an encrypted memory partition, and (optionally) its own TEE
            enclave on 0G Sandbox.
          </p>
        </header>

        <ol className="flex flex-col gap-10">
          {STEPS.map(step => (
            <li
              key={step.label}
              className="flex flex-col gap-4 border-t border-[var(--color-border)] pt-8 sm:flex-row sm:gap-10"
            >
              <div className="font-mono w-16 shrink-0 text-[11px] uppercase tracking-[0.22em] text-[var(--color-ink-3)]">
                {step.label}
              </div>
              <div className="flex-1 space-y-3">
                <h2 className="font-display text-[28px] font-light leading-tight text-[var(--color-ink)]">
                  {step.title}
                </h2>
                <p className="text-[14.5px] leading-relaxed text-[var(--color-ink-2)]">
                  {step.body}
                </p>
                <div className="font-mono mt-3 inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-paper)] px-3 py-2 text-[13px] text-[var(--color-ink)]">
                  <span className="select-none text-[var(--color-ink-3)]">$ </span>
                  <span>{step.code}</span>
                </div>
              </div>
            </li>
          ))}
        </ol>

        <footer className="border-t border-[var(--color-border)] pt-8">
          <p className="text-[14px] text-[var(--color-ink-2)]">
            Full reference + every CLI flag lives in the README on GitHub. The docs page you're
            reading is the curated path.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-5 text-[13px]">
            <Link
              href="https://github.com/s0nderlabs/anima#readme"
              target="_blank"
              rel="noreferrer"
              className="font-mono uppercase tracking-[0.18em] text-[var(--color-ink-2)] underline-offset-4 hover:underline"
            >
              full readme ↗
            </Link>
            <Link
              href="https://github.com/s0nderlabs/anima/releases"
              target="_blank"
              rel="noreferrer"
              className="font-mono uppercase tracking-[0.18em] text-[var(--color-ink-2)] underline-offset-4 hover:underline"
            >
              changelog ↗
            </Link>
            <Link
              href="/"
              className="font-mono uppercase tracking-[0.18em] text-[var(--color-ink-2)] underline-offset-4 hover:underline"
            >
              ← back to landing
            </Link>
          </div>
        </footer>
      </section>
      <Footer />
    </main>
  )
}
