import { PairingStore, agentPaths, iNFTAgentId } from '@s0nderlabs/anima-core'
import { getAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'

export interface RunPairingListOpts {
  platform?: string
}

export async function runPairingList(opts: RunPairingListOpts): Promise<void> {
  const store = await openPairingStore()
  if (!store) return

  const pending = store.listPending(opts.platform)
  const approved = store.listApproved(opts.platform)

  const pendingTitle = opts.platform ? `Pending (${opts.platform})` : 'Pending'
  console.log(`\n${pendingTitle} (1h TTL):`)
  if (pending.length === 0) {
    console.log('  (none)')
  } else {
    for (const p of pending) {
      const userLabel = p.userName ? `@${p.userName}` : '(unknown)'
      const idLabel = `id=${p.userId}`
      console.log(`  [${p.platform}] ${p.code}  ${userLabel} ${idLabel}  age=${p.ageMinutes}m`)
    }
  }

  const approvedTitle = opts.platform ? `Approved (${opts.platform})` : 'Approved'
  console.log(`\n${approvedTitle}:`)
  if (approved.length === 0) {
    console.log('  (none)')
  } else {
    for (const a of approved) {
      const userLabel = a.userName ? `@${a.userName}` : '(unknown)'
      const idLabel = `id=${a.userId}`
      console.log(`  [${a.platform}] ${userLabel} ${idLabel}`)
    }
  }
  console.log()
}

async function openPairingStore(): Promise<PairingStore | null> {
  const loaded = await findAndLoadConfig()
  if (!loaded) {
    console.error('No anima.config.ts found. Run `anima init` first.')
    return null
  }
  const { config } = loaded
  if (!config.identity.iNFT) {
    console.error('Config has no iNFT. Run `anima init` first.')
    return null
  }
  const inftContract = getAddress(config.identity.iNFT.contract) as `0x${string}`
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentId = iNFTAgentId({ contractAddress: inftContract, tokenId })
  const dir = agentPaths.agent(agentId).pairingDir
  return new PairingStore({ dir })
}
