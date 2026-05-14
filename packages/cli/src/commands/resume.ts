import { cancel, confirm, intro, isCancel, note, outro, spinner } from '@clack/prompts'
import {
  type AnimaNetwork,
  SANDBOX_PROVIDER_URL_GALILEO,
  SandboxProviderClient,
  iNFTAgentId,
} from '@s0nderlabs/anima-core'
import type { Address, Hex } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { loadProfileScopeKeyHex } from '../util/profile-key'
import { loadTelegramHandoffSecrets } from '../util/telegram-secrets'
import { loadOrPickOperatorSigner } from './init/operator-picker'
import {
  preflightProviderDeposit,
  resumeArchivedSandbox,
  unlockAgentKeystore,
} from './init/sandbox-provision'

interface ResumeOpts {
  yes?: boolean
}

/**
 * `anima resume`: wake a stopped/archived sandbox and re-handoff the agent
 * privkey to the (newly restarted) harness. Use when:
 *
 *  - Daytona's billing daemon archived the sandbox (INSUFFICIENT_BALANCE)
 *  - The autoArchiveInterval timer fired after a Daytona infra event stopped
 *    the sandbox briefly
 *  - You manually called `archive` and now want it back
 *
 * Same sandbox UUID + endpoint preserved. ~30s for stopped sandboxes,
 * 2-5 min for archived (Daytona restores filesystem from object storage).
 */
export async function runResume(opts: ResumeOpts = {}): Promise<void> {
  intro('anima resume')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No anima.config.ts found.')
    return
  }
  const { config } = loaded
  if (!config.identity.iNFT || !config.identity.agent) {
    cancel('Config has no iNFT or agent.')
    return
  }
  if (config.deployTarget !== 'sandbox' || !config.sandbox?.id || !config.sandbox.endpoint) {
    cancel(
      `Agent is not deployed to a sandbox. (deployTarget=${config.deployTarget ?? 'local'}). Nothing to resume.`,
    )
    return
  }
  if (!config.brain.provider) {
    cancel('Brain provider not configured. Run `anima model` first.')
    return
  }

  const contractAddress = config.identity.iNFT.contract as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentAddress = config.identity.agent as Address
  const sandboxId = config.sandbox.id

  const operator = await loadOrPickOperatorSigner({
    network: config.network,
    hint: config.operator,
  })
  if (!operator) {
    cancel('No operator wallet available; cannot decrypt keystore.')
    return
  }

  // Pre-flight Galileo deposit check. The May 2 INSUFFICIENT_BALANCE incident
  // archived enigma; refusing up-front with a clear suggestion is much better
  // UX than letting resume run, sign the keystore unlock, then fail mid-flow.
  if (!(await preflightProviderDeposit(operator))) {
    await operator.close?.()
    return
  }

  if (!opts.yes) {
    const ok = await confirm({
      message: `Resume sandbox ${sandboxId.slice(0, 8)}? (~30s if stopped, ~2-5min if archived)`,
      initialValue: true,
    })
    if (isCancel(ok) || !ok) {
      cancel('Aborted.')
      await operator.close?.()
      return
    }
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

  const operatorAccount = await operator.account()
  const provider = new SandboxProviderClient({
    endpoint: SANDBOX_PROVIDER_URL_GALILEO,
    operator: operatorAccount,
  })

  // Ship telegram secrets via secondary envelope so the resumed harness
  // restores its grammY listener. Without this, every pause→resume cycle
  // silently strips the bot — gateway comes back with `plugins: ['telegram']`
  // but no token, and `build-runtime.ts` skips listener registration.
  const telegramSecretsPlain = await loadTelegramHandoffSecrets({
    signer: operator,
    agentAddress,
    contractAddress,
    tokenId,
    onNotice: msg => note(`${msg}; resume continues without TG.`, 'warning'),
  })
  const resumeAgentId = iNFTAgentId({ contractAddress, tokenId })
  const resumeProfileKeyHex = loadProfileScopeKeyHex(resumeAgentId)
  if (!resumeProfileKeyHex) {
    note('no cached PROFILE key; resumed sandbox will boot without profile-slot anchoring', 'note')
  }

  const sBox = spinner()
  sBox.start('Resuming sandbox')
  try {
    const result = await resumeArchivedSandbox({
      provider,
      sandboxId,
      sandboxEndpoint: config.sandbox.endpoint,
      operatorAccount,
      agentPrivkey,
      agentAddress,
      iNFTRef: { contract: contractAddress, tokenId },
      iNFTNetwork: config.network as AnimaNetwork,
      brain: { provider: config.brain.provider as Address, model: config.brain.model ?? '' },
      subname: config.subname,
      plugins: config.plugins,
      telegramSecrets: telegramSecretsPlain,
      profileScopeKeyHex: resumeProfileKeyHex,
      onProgress: msg => sBox.message(msg),
    })
    if (result.alreadyReady) {
      sBox.stop(`sandbox ${sandboxId.slice(0, 8)} already Ready (no-op)`)
    } else {
      sBox.stop(`sandbox ${sandboxId.slice(0, 8)} resumed from ${result.initialState} → started`)
    }
    outro(
      [
        '',
        `  sandbox       ${sandboxId} (unchanged)`,
        `  endpoint      ${config.sandbox.endpoint} (unchanged)`,
        `  state before  ${result.initialState}`,
        '  state now     started',
        '',
        'Next: `anima` to chat',
      ].join('\n'),
    )
  } catch (e) {
    sBox.stop(`resume failed: ${(e as Error).message.slice(0, 200)}`)
    note(
      [
        'The sandbox could not be brought back to started state.',
        'If state is `error`, the underlying snapshot may be lost. Run `anima upgrade --reprovision` to spin a fresh container.',
      ].join('\n'),
      'recoverable',
    )
  } finally {
    await operator.close?.()
  }
}
