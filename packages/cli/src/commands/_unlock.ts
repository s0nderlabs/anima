import { spinner } from '@clack/prompts'
import {
  type AnimaConfig,
  type AnimaNetwork,
  agentPaths,
  fetchAndDecryptKeystore,
  iNFTAgentId,
} from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'
import { withSilencedConsole } from '../util/silence-console'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export interface UnlockedAgent {
  agentPrivkey: Hex
  agentAddress: Address
  network: AnimaNetwork
  close: () => Promise<void>
}

/**
 * Shared operator-unlock dance for any command that needs the agent privkey:
 *  1. pick the operator signer (keystore / WC / keychain) per config hint
 *  2. fetch the encrypted keystore from 0G Storage
 *  3. decrypt via operator signature
 *
 * Returns null if the operator picker is cancelled or the keystore can't be
 * decrypted; caller should bail out early on null.
 *
 * The unlock spinner is rendered with the passed `spinnerLabel` so each caller
 * keeps its own copy.
 *
 * Caller MUST call `close()` once done with the privkey, even on success, to
 * release WC sessions / keystore tmpfiles.
 */
export async function unlockAgentSigner(
  config: AnimaConfig,
  spinnerLabel = 'Fetching encrypted keystore + decrypting via operator wallet',
): Promise<UnlockedAgent | null> {
  if (!config.identity.iNFT || !config.identity.agent) return null
  const network = config.network
  const agentAddress = config.identity.agent as Address
  const inftContract = config.identity.iNFT.contract as Address
  const inftTokenId = BigInt(config.identity.iNFT.tokenId)
  const finalAgentId = iNFTAgentId({ contractAddress: inftContract, tokenId: inftTokenId })
  const paths = agentPaths.agent(finalAgentId)

  const operator = await loadOrPickOperatorSigner({ network, hint: config.operator })
  if (!operator) return null

  const close = async () => {
    await operator.close?.()
  }

  const s = spinner()
  s.start(spinnerLabel)
  try {
    const decrypted = await withSilencedConsole(() =>
      fetchAndDecryptKeystore({
        network,
        contractAddress: inftContract,
        tokenId: inftTokenId,
        signer: operator,
        agentAddress,
        cachePath: paths.keystore,
      }),
    )
    s.stop(`unlocked (keystore source: ${decrypted.source})`)
    return { agentPrivkey: decrypted.privkeyHex, agentAddress, network, close }
  } catch (e) {
    s.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
    await close()
    return null
  }
}
