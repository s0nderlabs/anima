import { cancel, intro, note, outro, spinner } from '@clack/prompts'
import {
  type AnimaConfig,
  NETWORK_CHAIN_ID,
  agentPaths,
  explorerTxUrl,
  fetchAndDecryptKeystore,
  iNFTAgentId,
  openComputeLedger,
} from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'
import { loadOrPickOperatorSigner } from './operator-picker'
import { readWizardState, updateWizardState } from './wizard-state'

/**
 * Resume a partial `anima init` that crashed after mint + funding. Phase 6.6
 * requires that the keystore was uploaded to 0G Storage before resume can
 * proceed — otherwise the agent privkey is lost (it only existed in the
 * original wizard's RAM).
 */
export async function runResumeInit(opts: {
  config: AnimaConfig
  configPath: string
}): Promise<void> {
  intro('anima init --resume')

  const { config } = opts
  if (!config.identity.iNFT || !config.identity.agent) {
    cancel('No iNFT or agent address in config. Nothing to resume — run `anima init` fresh.')
    return
  }
  const network = config.network
  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentAddress = config.identity.agent as Address
  const finalAgentId = iNFTAgentId({ contractAddress, tokenId })
  const paths = agentPaths.agent(finalAgentId)

  const state = await readWizardState(paths.dir)
  if (!state) {
    cancel(
      `No state file at ${paths.dir}. If init was never started, run \`anima init\` without --resume.`,
    )
    return
  }

  if (!state.steps.mintTx || !state.steps.agentFundedTx) {
    cancel(
      'Mint or agent-funding did not complete. Resume only supports steps after funding. Start fresh with `anima init` (pick Overwrite) and re-mint.',
    )
    return
  }

  if (!state.steps.keystorePersistedTx) {
    cancel(
      [
        'Keystore was never uploaded to 0G Storage. The agent privkey only',
        "existed in the original wizard's RAM, so it is unrecoverable now.",
        'Start fresh with `anima init` and re-mint into a new iNFT.',
      ].join(' '),
    )
    return
  }

  const operator = await loadOrPickOperatorSigner({ network, hint: config.operator })
  if (!operator) {
    cancel('No operator wallet available; cannot decrypt keystore to resume.')
    return
  }

  const sUnlock = spinner()
  sUnlock.start('Fetching keystore from 0G Storage + decrypting via operator')
  let agentPrivkey: Hex
  try {
    const decrypted = await fetchAndDecryptKeystore({
      network,
      contractAddress,
      tokenId,
      signer: operator,
      agentAddress,
      cachePath: paths.keystore,
    })
    agentPrivkey = decrypted.privkeyHex
    sUnlock.stop(`unlocked (keystore source: ${decrypted.source})`)
  } catch (e) {
    sUnlock.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
    await operator.close?.()
    return
  }

  if (!state.steps.ledgerOpenedTx) {
    const s = spinner()
    s.start('Opening 0G Compute ledger (3 0G minimum, top up later)')
    try {
      const status = await openComputeLedger({
        network,
        privkeyHex: agentPrivkey,
        initialBalance: 3,
        providerAddress: config.brain.provider ?? undefined,
      })
      await updateWizardState(paths.dir, draft => {
        draft.steps.ledgerOpenedTx = true
      })
      s.stop(
        status.alreadyExisted ? 'ledger already existed, topped up' : 'ledger opened with 3 0G',
      )
    } catch (e) {
      s.stop(`ledger open failed: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  // Subname records are not resumable: the state file intentionally doesn't
  // persist the requested label, so if text records are incomplete we tell
  // the user to re-run `anima init` and pick the same label manually.
  if (!state.steps.subnameClaimedTx) {
    note(
      'If you wanted a subname, re-run `anima init` (it can re-pick the same label).',
      'subname not resumable',
    )
  }

  await operator.close?.()

  outro(
    [
      '',
      `  agent     ${agentAddress}`,
      `  iNFT      #${tokenId.toString()} at ${contractAddress}`,
      `  tx        ${explorerTxUrl(network, state.steps.mintTx as Hex)}`,
      `  keystore  ${paths.keystore} (cache of 0G Storage blob)`,
      `  chain id  ${NETWORK_CHAIN_ID[network]}`,
      '',
      'Resume finished. `anima` to chat, `anima status` for health.',
    ].join('\n'),
  )
}
