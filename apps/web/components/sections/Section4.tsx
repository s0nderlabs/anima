// Section 4 · Closing CTA card
// Full implementation lands in Phase F of the build plan.

import { ClosingCta } from './section4/ClosingCta'

export function Section4() {
  return (
    <section
      id="section-closing"
      className="relative flex min-h-screen items-center bg-[var(--color-cream)] py-[var(--section-py)]"
    >
      <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 sm:px-8">
        <ClosingCta />
      </div>
    </section>
  )
}
