import { cancel, intro, isCancel, note, outro, select, spinner } from '@clack/prompts'
import { NETWORK_CHAIN_ID, iNFTAgentId } from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { loadProfileScopeKeyHex } from '../util/profile-key'
import { loadTelegramHandoffSecrets } from '../util/telegram-secrets'
import { loadOrPickOperatorSigner } from './init/operator-picker'
import {
  publishSandboxEndpoint,
  runSandboxProvision,
  unlockAgentKeystore,
} from './init/sandbox-provision'

/**
 * `anima deploy` — migrate an existing local-mode agent into 0G Sandbox via
 * Option 3 ECIES handoff.
 *
 * Pre-conditions:
 *   - Config exists, deployTarget is `local`
 *   - iNFT minted, agent EOA funded, keystore on 0G Storage
 *   - Operator wallet can decrypt the keystore (Phase 6.6 sign-derived-key)
 *
 * Flow:
 *   1. Decrypt agent privkey (operator wallet, Phase 6.6 keystore-blob)
 *   2. Galileo testnet: deposit + acknowledge TEE signer (idempotent)
 *   3. createSandbox + bootstrap + poll /bootstrap/pubkey
 *   4. encryptToPubkey(agentPrivkey, bootstrapPubkey) + operator-sign envelope
 *   5. POST /bootstrap/provision → harness adopts the agent privkey
 *   6. Wait for /healthz Ready
 *   7. Update `agent:endpoint` text record on subname (if registered)
 *   8. Rewrite config with deployTarget=sandbox + sandbox.id/endpoint/etc
 *
 * Local mode keystore + mainnet iNFT + agent EOA all stay valid; if the
 * sandbox container is later deleted, operator can re-`anima deploy`.
 */
export async function runDeploy(): Promise<void> {
  intro('anima deploy')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No anima.config.ts found. Run `anima init` first.')
    return
  }
  let { config } = loaded

  if (!config.identity.iNFT || !config.identity.agent) {
    cancel('Config has no iNFT or agent. Run `anima init` first.')
    return
  }
  if (config.deployTarget === 'sandbox' && config.sandbox?.id) {
    note(
      `Already deployed: sandbox=${config.sandbox.id}\nEndpoint: ${config.sandbox.endpoint}\nTo move to a new container, run \`anima upgrade\` instead.`,
      'sandbox already attached',
    )
    cancel('No-op.')
    return
  }
  if (!config.brain.provider) {
    cancel('Brain provider not configured. Run `anima model` first.')
    return
  }

  const target = (await select({
    message: 'Migrate to which target?',
    options: [
      {
        value: 'sandbox-galileo' as const,
        label: '0G Sandbox (Galileo testnet, TDX TEE)',
      },
    ],
    initialValue: 'sandbox-galileo',
  })) as 'sandbox-galileo' | symbol
  if (isCancel(target)) {
    cancel('Aborted.')
    return
  }

  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentAddress = config.identity.agent as Address

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

  const sBox = spinner()
  sBox.start('Provisioning 0G Sandbox container (Galileo testnet)')
  const telegramSecretsPlain = await loadTelegramHandoffSecrets({
    signer: operator,
    agentAddress,
    contractAddress,
    tokenId,
    onNotice: msg => sBox.message(msg),
  })
  const deployAgentId = iNFTAgentId({ contractAddress, tokenId })
  const deployProfileKeyHex = loadProfileScopeKeyHex(deployAgentId)
  if (!deployProfileKeyHex) {
    sBox.message('no cached PROFILE key; sandbox will boot without profile-slot anchoring')
  }
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
      ref: process.env.ANIMA_BOOTSTRAP_REF ?? 'main',
      subname: config.subname,
      telegramSecrets: telegramSecretsPlain,
      profileScopeKeyHex: deployProfileKeyHex,
      onProgress: msg => sBox.message(msg),
    })
    sBox.stop(`sandbox ${sandboxResult.sandboxId} ready @ ${sandboxResult.endpoint}`)
  } catch (e) {
    sBox.stop(`sandbox deploy failed: ${(e as Error).message.slice(0, 200)}`)
    note(
      [
        'Local agent untouched; iNFT + EOA + keystore remain on 0G Storage.',
        'Common causes:',
        '  - insufficient testnet 0G at operator wallet',
        '  - provider 504 / Daytona upstream timeout',
        '  - npm mode (default): bun add -g failed (registry transient or missing version)',
        '  - git mode: bootstrap script git clone failed (pin a different ref via ANIMA_BOOTSTRAP_REF)',
        '  - try forcing the other mode: ANIMA_BOOTSTRAP_MODE=git anima deploy (for unreleased commits)',
      ].join('\n'),
      'recoverable',
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
      sEp.stop('agent:endpoint published')
    } catch (e) {
      sEp.stop(`agent:endpoint publish failed: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  config = {
    ...config,
    deployTarget: 'sandbox' as const,
    sandbox: {
      ...(config.sandbox ?? {}),
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
      `  sandbox id    ${sandboxResult.sandboxId}`,
      `  endpoint      ${sandboxResult.endpoint}`,
      `  agent (in TEE) ${agentAddress}`,
      `  iNFT          #${tokenId.toString()} on chain ${NETWORK_CHAIN_ID[config.network]}`,
      '',
      'Next: `anima` to chat (now routes through the sandbox harness)',
      '      `anima upgrade` to swap the container while preserving identity',
    ].join('\n'),
  )
}
