import { confirm, isCancel } from '@clack/prompts'
import { PairingStore, agentPaths, iNFTAgentId } from '@s0nderlabs/anima-core'
import { getAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'

export interface RunPairingClearOpts {
  platform?: string
  yes?: boolean
}

export async function runPairingClear(opts: RunPairingClearOpts): Promise<void> {
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

  if (!opts.yes) {
    const target = opts.platform ? `${opts.platform} pending` : 'ALL pending pairing codes'
    const ok = await confirm({
      message: `Clear ${target}?`,
      initialValue: false,
    })
    if (isCancel(ok) || !ok) {
      console.log('Aborted.')
      return
    }
  }

  const count = store.clearPending(opts.platform)
  console.log(`✓ Cleared ${count} pending pairing code${count === 1 ? '' : 's'}`)
}
