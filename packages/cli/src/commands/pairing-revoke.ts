import { confirm, isCancel } from '@clack/prompts'
import { PairingStore, agentPaths, iNFTAgentId } from '@s0nderlabs/anima-core'
import { getAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'

export interface RunPairingRevokeOpts {
  platform: string
  userId: string
  yes?: boolean
}

export async function runPairingRevoke(opts: RunPairingRevokeOpts): Promise<void> {
  const loaded = await findAndLoadConfig()
  if (!loaded) {
    console.error('No anima.config.ts found. Run `anima init` first.')
    process.exit(1)
  }
  const { config } = loaded
  if (!config.identity.iNFT) {
    console.error('Config has no iNFT. Run `anima init` first.')
    process.exit(1)
  }
  const inftContract = getAddress(config.identity.iNFT.contract) as `0x${string}`
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentId = iNFTAgentId({ contractAddress: inftContract, tokenId })
  const dir = agentPaths.agent(agentId).pairingDir
  const store = new PairingStore({ dir })

  if (!store.isApproved(opts.platform, opts.userId)) {
    console.error(`User ${opts.userId} is not on the ${opts.platform} approved list.`)
    process.exit(1)
  }

  if (!opts.yes) {
    const ok = await confirm({
      message: `Revoke ${opts.platform} access for user id ${opts.userId}?`,
      initialValue: false,
    })
    if (isCancel(ok) || !ok) {
      console.log('Aborted.')
      return
    }
  }

  const removed = store.revoke(opts.platform, opts.userId)
  if (removed) {
    console.log(`✓ Revoked: ${opts.platform} id=${opts.userId}`)
  } else {
    console.error('Revoke failed (concurrent removal?)')
    process.exit(1)
  }
}
