import { cancel, intro, outro, spinner } from '@clack/prompts'
import {
  MemorySyncManager,
  agentPaths,
  explorerTxUrl,
  fetchAndDecryptKeystore,
  iNFTAgentId,
} from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { withSilencedConsole } from '../util/silence-console'
import { loadOrPickOperatorSigner } from './init/operator-picker'

/**
 * `anima sync` — explicit memory + activity-log flush to 0G Storage and
 * anchor on chain via iNFT updateSlots. Useful pre-transfer or as a
 * scheduled cron. Per-turn auto-sync covers the common path; this is the
 * "force flush now" backstop.
 */
export async function runSync(): Promise<void> {
  intro('anima sync')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No anima.config.ts found. Run `anima init` first.')
    return
  }
  const { config } = loaded
  if (!config.identity.iNFT || !config.identity.agent) {
    cancel('Config has no iNFT or agent. Run `anima init` first.')
    return
  }

  const network = config.network
  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentAddress = config.identity.agent as Address
  const finalAgentId = iNFTAgentId({ contractAddress, tokenId })
  const paths = agentPaths.agent(finalAgentId)

  const operator = await loadOrPickOperatorSigner({ network, hint: config.operator })
  if (!operator) {
    cancel('No operator wallet available; cannot decrypt keystore to sync.')
    return
  }

  const sUnlock = spinner()
  sUnlock.start('Fetching keystore + decrypting via operator')
  let agentPrivkey: Hex
  try {
    const decrypted = await withSilencedConsole(() =>
      fetchAndDecryptKeystore({
        network,
        contractAddress,
        tokenId,
        signer: operator,
        agentAddress,
        cachePath: paths.keystore,
      }),
    )
    agentPrivkey = decrypted.privkeyHex
    sUnlock.stop(`unlocked (source: ${decrypted.source})`)
  } catch (e) {
    sUnlock.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
    await operator.close?.()
    return
  }
  await operator.close?.()

  const sFlush = spinner()
  sFlush.start('Diffing memory + activity, uploading changed blobs, anchoring on chain')
  try {
    const res = await withSilencedConsole(async () => {
      const sync = new MemorySyncManager({
        network,
        agentId: finalAgentId,
        agentPrivkey,
        agentAddress,
        contractAddress,
        tokenId,
      })
      await sync.init()
      return await sync.flushAll()
    })
    if (res.txHash) {
      sFlush.stop(`anchored ${res.changedSlots.length} slot(s)`)
      outro(
        [
          '',
          `  slots updated: ${res.changedSlots.join(', ')}`,
          `  tx: ${explorerTxUrl(network, res.txHash)}`,
        ].join('\n'),
      )
    } else {
      sFlush.stop('nothing to sync (everything up to date)')
    }
  } catch (e) {
    sFlush.stop(`sync failed: ${(e as Error).message.slice(0, 200)}`)
  }
}
