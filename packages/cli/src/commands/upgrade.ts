import { cancel, confirm, intro, isCancel, note, outro, spinner } from '@clack/prompts'
import { SANDBOX_PROVIDER_URL_GALILEO, SandboxProviderClient } from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { loadOrPickOperatorSigner } from './init/operator-picker'
import {
  publishSandboxEndpoint,
  runSandboxProvision,
  unlockAgentKeystore,
} from './init/sandbox-provision'

interface UpgradeOpts {
  /** Override the bootstrap-script git ref. Default = `ANIMA_BOOTSTRAP_REF` env or `main`. */
  ref?: string
  /** Skip the `confirm` gate (for scripted workflows). */
  yes?: boolean
}

/**
 * `anima upgrade` — swap the sandbox harness container while preserving
 * agent identity + memory. Operator decrypts the existing keystore once,
 * old container is deleted, a fresh one is provisioned with the same agent
 * privkey via Option 3 handoff, agent:endpoint text record updated.
 *
 * Net result: same iNFT, same agent EOA, same memory on 0G Storage, fresh
 * container running latest code. ~60-90s downtime.
 */
export async function runUpgrade(opts: UpgradeOpts = {}): Promise<void> {
  intro('anima upgrade')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No anima.config.ts found.')
    return
  }
  let { config } = loaded
  if (!config.identity.iNFT || !config.identity.agent) {
    cancel('Config has no iNFT or agent.')
    return
  }
  if (config.deployTarget !== 'sandbox' || !config.sandbox?.id || !config.sandbox.endpoint) {
    cancel(
      `Agent is not deployed to a sandbox. (deployTarget=${config.deployTarget ?? 'local'}). Run \`anima deploy\` first.`,
    )
    return
  }
  if (!config.brain.provider) {
    cancel('Brain provider not configured. Run `anima model` first.')
    return
  }

  const ref = opts.ref ?? process.env.ANIMA_BOOTSTRAP_REF ?? 'main'
  if (!opts.yes) {
    const ok = await confirm({
      message: `Replace sandbox ${config.sandbox.id.slice(0, 8)} with a fresh container at ref=${ref}? (~60-90s downtime)`,
      initialValue: true,
    })
    if (isCancel(ok) || !ok) {
      cancel('Aborted.')
      return
    }
  }

  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentAddress = config.identity.agent as Address
  const oldSandboxId = config.sandbox.id

  const operator = await loadOrPickOperatorSigner({
    network: config.network,
    hint: config.operator,
  })
  if (!operator) {
    cancel('No operator wallet available; cannot decrypt keystore.')
    return
  }

  const sUnlock = spinner()
  sUnlock.start('Fetching keystore + decrypting via operator wallet')
  let agentPrivkey: Hex
  try {
    agentPrivkey = await unlockAgentKeystore({
      operator,
      network: config.network,
      contractAddress,
      tokenId,
      agentAddress,
    })
    sUnlock.stop('unlocked')
  } catch (e) {
    sUnlock.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
    await operator.close?.()
    return
  }

  const sDel = spinner()
  sDel.start(`Deleting old sandbox ${oldSandboxId}`)
  try {
    const operatorAccount = await operator.account()
    const provider = new SandboxProviderClient({
      endpoint: SANDBOX_PROVIDER_URL_GALILEO,
      operator: operatorAccount,
    })
    await provider.deleteSandbox(oldSandboxId)
    sDel.stop(`old sandbox ${oldSandboxId.slice(0, 8)} deleted`)
  } catch (e) {
    sDel.stop(`delete failed: ${(e as Error).message.slice(0, 160)}`)
    note(
      [
        'Old sandbox could not be deleted but provisioning a fresh one is still safe.',
        'You can manually delete the orphan via the provider dashboard later.',
      ].join('\n'),
      'continuing',
    )
  }

  const sBox = spinner()
  sBox.start('Provisioning fresh sandbox container')
  let sandboxResult: Awaited<ReturnType<typeof runSandboxProvision>>
  try {
    sandboxResult = await runSandboxProvision({
      operator,
      agentPrivkey,
      agentAddress,
      iNFTRef: { contract: contractAddress, tokenId },
      brain: {
        provider: config.brain.provider as Address,
        model: config.brain.model ?? '',
      },
      iNFTNetwork: config.network,
      name: config.subname || 'anima',
      ref,
      onProgress: msg => sBox.message(msg),
    })
    sBox.stop(`sandbox ${sandboxResult.sandboxId} ready @ ${sandboxResult.endpoint}`)
  } catch (e) {
    sBox.stop(`re-provision failed: ${(e as Error).message.slice(0, 200)}`)
    note(
      [
        'Old sandbox was deleted but the new one did not provision.',
        'Identity + funds + memory all safe on chain / 0G Storage.',
        'Re-run `anima upgrade` after fixing the issue, or `anima deploy` to start fresh.',
      ].join('\n'),
      'recoverable (agent offline)',
    )
    await operator.close?.()
    return
  }

  if (config.subname) {
    const sEp = spinner()
    sEp.start(`Updating agent:endpoint on ${config.subname}.anima.0g`)
    try {
      await publishSandboxEndpoint({
        subname: config.subname,
        agentPrivkey,
        endpoint: sandboxResult.endpoint,
      })
      sEp.stop('agent:endpoint updated')
    } catch (e) {
      sEp.stop(`agent:endpoint update failed: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  config = {
    ...config,
    sandbox: {
      ...config.sandbox,
      id: sandboxResult.sandboxId,
      providerAddress: sandboxResult.providerAddress,
      endpoint: sandboxResult.endpoint,
      snapshotName: sandboxResult.snapshotName,
    },
  }
  await writeConfigTs(loaded.path, config, { subname: config.subname ?? null })

  await operator.close?.()

  outro(
    [
      '',
      `  old sandbox   ${oldSandboxId}`,
      `  new sandbox   ${sandboxResult.sandboxId}`,
      `  endpoint      ${sandboxResult.endpoint}`,
      `  ref           ${ref}`,
      '',
      'Next: `anima` to chat (now routes through the new harness)',
    ].join('\n'),
  )
}
