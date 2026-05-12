'use client'

import { ActivityFeed } from '@/components/console/ActivityFeed'
import { UnlockKeystore } from '@/components/console/UnlockKeystore'
import { useAgentContext } from '@/components/console/agent-context'

export default function ActivityTab() {
  const ctx = useAgentContext()
  if (!ctx.agentEOA) {
    return (
      <div className="grid gap-3 pt-6">
        <span className="kicker">ACTIVITY · WAITING ON SUBNAME</span>
        <p className="max-w-[44ch] text-[15.5px] leading-[1.65] text-[var(--color-ink-2)]">
          We could not resolve this agent’s wallet address from the SANN registry. Decrypt needs
          that address. Register a subname via the CLI and reload.
        </p>
      </div>
    )
  }
  if (!ctx.unlocked) {
    return (
      <div className="pt-6">
        <UnlockKeystore agentAddress={ctx.agentEOA} />
      </div>
    )
  }
  return <ActivityFeed tokenId={ctx.tokenId} memoryKey={ctx.unlocked.memoryKey} />
}
