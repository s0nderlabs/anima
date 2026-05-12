'use client'

import { IdentityPanel } from '@/components/console/IdentityPanel'
import { useAgentContext } from '@/components/console/agent-context'

export default function IdentityTab() {
  const ctx = useAgentContext()
  return <IdentityPanel tokenId={ctx.tokenId} />
}
