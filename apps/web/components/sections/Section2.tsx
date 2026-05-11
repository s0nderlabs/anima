// Section 2 · Every layer on 0G
// 7 viewports: opener + Identity / Brain / Memory / Limbs / Comms / Economy.
// Full implementation lands in Phase D of the build plan.

import { V1Opener } from './section2/V1Opener'
import { V2Identity } from './section2/V2Identity'
import { V3Brain } from './section2/V3Brain'
import { V4Memory } from './section2/V4Memory'
import { V5Limbs } from './section2/V5Limbs'
import { V6Comms } from './section2/V6Comms'
import { V7Economy } from './section2/V7Economy'

export function Section2() {
  return (
    <section
      id="section-layers"
      className="relative bg-[var(--color-cream-deep)]"
    >
      <V1Opener />
      <V2Identity />
      <V3Brain />
      <V4Memory />
      <V5Limbs />
      <V6Comms />
      <V7Economy />
    </section>
  )
}
