'use client'

import { AgentEoaInput } from '@/components/console/AgentEoaInput'
import { MemoryBrowser } from '@/components/console/MemoryBrowser'
import { UnlockKeystore } from '@/components/console/UnlockKeystore'
import { useAgentContext } from '@/components/console/agent-context'

export default function MemoryTab() {
  const ctx = useAgentContext()

  if (!ctx.agentEOA) {
    return (
      <div className="pt-6">
        <AgentEoaInput />
      </div>
    )
  }

  if (!ctx.unlocked) {
    return (
      <div className="grid gap-6 pt-6">
        <UnlockKeystore agentAddress={ctx.agentEOA} />
      </div>
    )
  }

  return <MemoryBrowser tokenId={ctx.tokenId} memoryKey={ctx.unlocked.memoryKey} />
}
