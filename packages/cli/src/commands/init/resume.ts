import { cancel, intro, isCancel, outro, password, spinner } from '@clack/prompts'
import {
  type AnimaConfig,
  NETWORK_CHAIN_ID,
  agentPaths,
  explorerTxUrl,
  iNFTAgentId,
  loadKeystore,
  openComputeLedger,
  persistKeystoreToStorage,
} from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'
import { readWizardState, updateWizardState } from './wizard-state'

/**
 * Resume a partial `anima init` that crashed after mint. Only agent-only
 * steps are re-runnable here (keystore persistence, compute ledger, subname,
 * text records). If mint or agent-funding didn't complete, resume can't
 * recover — the user must run `anima init` fresh and re-mint.
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
      'Mint or agent-funding did not complete. Resume only supports agent-side steps. Start fresh with `anima init` (pick Overwrite) and re-mint.',
    )
    return
  }

  const pass = await password({
    message: `Unlock keystore for agent ${agentAddress}`,
  })
  if (isCancel(pass)) {
    cancel('Aborted.')
    return
  }

  let keystore: Awaited<ReturnType<typeof loadKeystore>>
  try {
    keystore = await loadKeystore(paths.keystore, pass)
  } catch (e) {
    cancel(`Keystore unlock failed: ${(e as Error).message}`)
    return
  }
  if (keystore.address.toLowerCase() !== agentAddress.toLowerCase()) {
    cancel(
      `Keystore address ${keystore.address} != config agent ${agentAddress}. Inconsistent state.`,
    )
    return
  }

  // Step: persist keystore to 0G Storage.
  if (!state.steps.keystorePersistedTx) {
    const s = spinner()
    s.start('Persisting encrypted keystore to 0G Storage')
    try {
      const { readFile } = await import('node:fs/promises')
      const keystoreBytes = new Uint8Array(await readFile(paths.keystore))
      const { rootHash, updateTx } = await persistKeystoreToStorage({
        network,
        agentPrivkey: keystore.privkeyHex as Hex,
        tokenId,
        contractAddress,
        keystoreBytes,
      })
      await updateWizardState(paths.dir, draft => {
        draft.steps.keystorePersistedTx = updateTx
        draft.steps.keystoreRootHash = rootHash
      })
      s.stop(`keystore anchored (root ${rootHash.slice(0, 12)}…)`)
    } catch (e) {
      s.stop(`keystore persistence failed: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  // Step: open compute ledger. We use a Starter default on resume since we
  // don't know the original ledger-size pick. User can `anima topup --compute`
  // to grow it afterward.
  if (!state.steps.ledgerOpenedTx) {
    const s = spinner()
    s.start('Opening 0G Compute ledger (3 0G minimum, top up later)')
    try {
      const status = await openComputeLedger({
        network,
        privkeyHex: keystore.privkeyHex as Hex,
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

  outro(
    [
      '',
      `  agent     ${agentAddress}`,
      `  iNFT      #${tokenId.toString()} at ${contractAddress}`,
      `  tx        ${explorerTxUrl(network, state.steps.mintTx as Hex)}`,
      `  keystore  ${paths.keystore}`,
      `  chain id  ${NETWORK_CHAIN_ID[network]}`,
      '',
      'Resume finished. `anima` to chat, `anima status` for health.',
    ].join('\n'),
  )
}
