import { cancel, confirm, intro, isCancel, note, outro, spinner } from '@clack/prompts'
import { SANDBOX_PROVIDER_URL_GALILEO, SandboxProviderClient } from '@s0nderlabs/anima-core'
import { findAndLoadConfig } from '../config/load'
import { loadOrPickOperatorSigner } from './init/operator-picker'
import { ensureSandboxArchived } from './init/sandbox-provision'

interface PauseOpts {
  yes?: boolean
}

/**
 * `anima pause`: archive a started sandbox to stop the runtime burn.
 *
 * Use during dev gaps to extend deposit runway. Sandbox UUID + endpoint
 * preserved; resume via `anima resume` (~2-5 min cold restore).
 *
 * Does NOT require operator-keystore unlock. Only needs the operator wallet
 * to sign the provider HTTP request (action=archive). Fast, low-friction.
 */
export async function runPause(opts: PauseOpts = {}): Promise<void> {
  intro('anima pause')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No anima.config.ts found.')
    return
  }
  const { config } = loaded
  if (config.deployTarget !== 'sandbox' || !config.sandbox?.id) {
    cancel(
      `Agent is not deployed to a sandbox. (deployTarget=${config.deployTarget ?? 'local'}). Nothing to pause.`,
    )
    return
  }

  const sandboxId = config.sandbox.id
  const operator = await loadOrPickOperatorSigner({
    network: config.network,
    hint: config.operator,
  })
  if (!operator) {
    cancel('No operator wallet available; cannot sign archive request.')
    return
  }

  if (!opts.yes) {
    const ok = await confirm({
      message: `Pause sandbox ${sandboxId.slice(0, 8)}? Burn stops; resume with \`anima resume\`.`,
      initialValue: true,
    })
    if (isCancel(ok) || !ok) {
      cancel('Aborted.')
      await operator.close?.()
      return
    }
  }

  const operatorAccount = await operator.account()
  const provider = new SandboxProviderClient({
    endpoint: SANDBOX_PROVIDER_URL_GALILEO,
    operator: operatorAccount,
  })

  const sBox = spinner()
  sBox.start('Archiving sandbox')
  try {
    const result = await ensureSandboxArchived(provider, sandboxId, {
      onProgress: msg => sBox.message(msg),
    })
    if (result.alreadyArchived) {
      sBox.stop(`sandbox ${sandboxId.slice(0, 8)} already archived (no-op)`)
    } else {
      sBox.stop(`sandbox ${sandboxId.slice(0, 8)} archived (was ${result.initialState})`)
    }
    outro(
      [
        '',
        `  sandbox       ${sandboxId} (preserved)`,
        `  endpoint      ${config.sandbox.endpoint} (preserved)`,
        `  state before  ${result.initialState}`,
        '  state now     archived',
        '  burn          stopped',
        '',
        'To wake: anima resume',
      ].join('\n'),
    )
  } catch (e) {
    sBox.stop(`pause failed: ${(e as Error).message.slice(0, 200)}`)
    note(
      [
        'The sandbox could not transition to archived.',
        'Run `anima status` to inspect, or retry. If the underlying state is bad, `anima upgrade --reprovision` is the escape hatch.',
      ].join('\n'),
      'recoverable',
    )
  } finally {
    await operator.close?.()
  }
}
