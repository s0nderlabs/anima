'use client'

import { WalletPanel } from '@/components/console/WalletPanel'
import { useAgentContext } from '@/components/console/agent-context'

export default function WalletTab() {
  const ctx = useAgentContext()
  return <WalletPanel agentAddress={ctx.agentEOA} />
}
