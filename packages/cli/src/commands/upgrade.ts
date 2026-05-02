import { cancel, confirm, intro, isCancel, note, outro, spinner } from '@clack/prompts'
import {
  type AnimaNetwork,
  type OperatorSigner,
  SANDBOX_PROVIDER_URL_GALILEO,
  SandboxProviderClient,
  type SandboxRecord,
} from '@s0nderlabs/anima-core'
import {
  UPGRADE_DONE_MARKER,
  UPGRADE_FAIL_KEYWORDS,
  UPGRADE_FAIL_MARKER,
  UPGRADE_PROGRESS_LOG,
  UPGRADE_SUCCESS_MARKER_PREFIX,
  buildUpgradeScript,
} from '@s0nderlabs/anima-harness'
import type { Address, Hex } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { SandboxClient } from '../sandbox/client'
import { loadOrPickOperatorSigner } from './init/operator-picker'
import {
  extractExecOutput,
  handoffAgentToHarness,
  makeExecRead,
  publishSandboxEndpoint,
  runSandboxProvision,
  unlockAgentKeystore,
} from './init/sandbox-provision'

export type UpgradeMode = 'in-place' | 'reprovision'

interface UpgradeOpts {
  ref?: string
  yes?: boolean
  /**
   * Opt into the heavy container-swap path. Default (false) is in-place. We
   * default to in-place because anima's harness layer is unsealed
   * (`feedback-anima-is-unsealed-currently.md`), so a fresh container buys
   * no real attestation freshness. Heavy mode is reserved for the future
   * when sealed mode + image-hash attestation are wired up.
   */
  reprovision?: boolean
}

/**
 * `anima upgrade`: roll the sandbox harness to a new git ref while preserving
 * agent identity + memory.
 *
 * Default = in-place: `git fetch + checkout + bun install + harness restart`
 * inside the existing Daytona container. ~30-60s downtime, $0 testnet cost,
 * same sandbox UUID + endpoint.
 *
 * `--reprovision` (opt-in) = container swap: delete old sandbox + provision
 * fresh + ECIES-handoff + publish new endpoint. ~2-5 min, ~0.9 0G testnet
 * provider deposit. Reserved for sealed mode where attestation freshness is
 * a load-bearing primitive.
 *
 * Both paths preserve: iNFT, agent EOA, encrypted keystore on 0G Storage,
 * memory anchored on chain, 0G Compute ledger.
 */
export async function runUpgrade(opts: UpgradeOpts = {}): Promise<void> {
  intro('anima upgrade')

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
      `Agent is not deployed to a sandbox. (deployTarget=${config.deployTarget ?? 'local'}). Run \`anima deploy\` first.`,
    )
    return
  }
  if (!config.brain.provider) {
    cancel('Brain provider not configured. Run `anima model` first.')
    return
  }

  const ref = opts.ref ?? process.env.ANIMA_BOOTSTRAP_REF ?? 'main'
  const mode: UpgradeMode = opts.reprovision ? 'reprovision' : 'in-place'

  if (!opts.yes) {
    const message =
      mode === 'reprovision'
        ? `Reprovision sandbox ${config.sandbox.id.slice(0, 8)} with a fresh container at ref=${ref}? (~60-90s downtime, ~0.9 0G testnet)`
        : `Upgrade sandbox ${config.sandbox.id.slice(0, 8)} in place to ref=${ref}? (~30-60s downtime)`
    const ok = await confirm({ message, initialValue: true })
    if (isCancel(ok) || !ok) {
      cancel('Aborted.')
      return
    }
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

  if (mode === 'reprovision') {
    await runReprovisionUpgrade({
      operator,
      agentPrivkey,
      agentAddress,
      contractAddress,
      tokenId,
      oldSandboxId: sandboxId,
      config,
      loadedPath: loaded.path,
      ref,
    })
  } else {
    await runInPlaceUpgrade({
      operator,
      agentPrivkey,
      agentAddress,
      contractAddress,
      tokenId,
      sandboxId,
      sandboxEndpoint: config.sandbox.endpoint,
      iNFTNetwork: config.network,
      brain: { provider: config.brain.provider as Address, model: config.brain.model ?? '' },
      ref,
    })
  }

  await operator.close?.()
}

interface InPlaceUpgradeArgs {
  operator: OperatorSigner
  agentPrivkey: Hex
  agentAddress: Address
  contractAddress: Address
  tokenId: bigint
  sandboxId: string
  sandboxEndpoint: string
  iNFTNetwork: AnimaNetwork
  brain: { provider: Address; model: string }
  ref: string
}

async function runInPlaceUpgrade(args: InPlaceUpgradeArgs): Promise<void> {
  const operatorAccount = await args.operator.account()
  const provider = new SandboxProviderClient({
    endpoint: SANDBOX_PROVIDER_URL_GALILEO,
    operator: operatorAccount,
  })

  const sBox = spinner()
  sBox.start('Verifying sandbox state')
  let sb: SandboxRecord
  try {
    sb = await provider.getSandbox(args.sandboxId)
  } catch (e) {
    sBox.stop(`getSandbox failed: ${(e as Error).message.slice(0, 160)}`)
    note(
      [
        'The sandbox provider could not confirm the sandbox is reachable.',
        'If this persists, run `anima upgrade --reprovision` to provision a fresh container.',
      ].join('\n'),
      'recoverable',
    )
    return
  }
  if (sb.state !== 'started') {
    sBox.message(`sandbox state=${sb.state}, starting`)
    try {
      await provider.startSandbox(args.sandboxId)
      const startDeadline = Date.now() + 60_000
      while (Date.now() < startDeadline) {
        const cur = await provider.getSandbox(args.sandboxId).catch(() => null)
        if (cur?.state === 'started') break
        await sleep(2000)
      }
    } catch (e) {
      sBox.stop(`startSandbox failed: ${(e as Error).message.slice(0, 160)}`)
      return
    }
  }

  sBox.message(`launching in-place upgrade to ref=${args.ref}`)
  const { script } = buildUpgradeScript({
    sandboxId: args.sandboxId,
    operatorAddress: operatorAccount.address,
    ref: args.ref,
  })
  let launchOut: string
  try {
    const launch = await provider.execInToolbox(args.sandboxId, { command: script, timeout: 60 })
    launchOut = extractExecOutput(launch)
    if (launch.exitCode !== 0) {
      sBox.stop(`upgrade launch failed exitCode=${launch.exitCode}`)
      note(launchOut.slice(0, 400), 'launch output')
      return
    }
  } catch (e) {
    sBox.stop(`execInToolbox failed: ${(e as Error).message.slice(0, 160)}`)
    return
  }

  // Poll done/fail markers (mirror sandbox-provision Step 3 pattern).
  sBox.message('upgrade running (git fetch + bun install + harness restart)')
  const execRead = makeExecRead(provider, args.sandboxId)
  // Lean poll: just FAIL + DONE markers (cheap `cat` of small files). The
  // progress-log `tail` only attaches every 6th tick (~30s) since the
  // consumer throttles its UX echo at 30s anyway. Saves ~5/6 of the
  // signed-exec response payload through Daytona's HTTP channel.
  const FAST_POLL = `echo --F--; cat ${UPGRADE_FAIL_MARKER} 2>/dev/null; echo --D--; cat ${UPGRADE_DONE_MARKER} 2>/dev/null`
  const SLOW_POLL = `${FAST_POLL}; echo --P--; tail -n 1 ${UPGRADE_PROGRESS_LOG} 2>/dev/null`
  const upgradeDeadline = Date.now() + 360_000 // 6 min ceiling for in-place
  let tick = 0
  let lastDone = ''
  while (Date.now() < upgradeDeadline) {
    const surfaceProgress = ++tick % 6 === 0
    const out = await execRead(surfaceProgress ? SLOW_POLL : FAST_POLL)
    const fail = sliceBetween(out, '--F--', '--D--')
    const done = surfaceProgress ? sliceBetween(out, '--D--', '--P--') : sliceAfter(out, '--D--')
    const failKeyword = UPGRADE_FAIL_KEYWORDS.find(k => fail.includes(k))
    if (failKeyword) {
      const log = await execRead(`tail -n 80 ${UPGRADE_PROGRESS_LOG} 2>/dev/null`)
      sBox.stop(`upgrade-failed: ${failKeyword}`)
      note(
        [
          `step failed: ${failKeyword}`,
          'log tail:',
          log.slice(-400),
          '',
          'You can retry with `anima upgrade` (the script is idempotent),',
          'or fall back to `anima upgrade --reprovision` for a fresh container.',
        ].join('\n'),
        'recoverable',
      )
      return
    }
    if (done.includes(UPGRADE_SUCCESS_MARKER_PREFIX)) {
      lastDone = done
      const pidLine =
        done
          .split('\n')
          .find(l => l.includes(UPGRADE_SUCCESS_MARKER_PREFIX))
          ?.trim() ?? done.trim()
      sBox.message(`upgrade complete (${pidLine})`)
      break
    }
    if (surfaceProgress) {
      const real = sliceAfter(out, '--P--').trim().split('\n').pop()
      if (real) sBox.message(`upgrade: ${real}`)
    }
    await sleep(5000)
  }
  if (!lastDone.includes(UPGRADE_SUCCESS_MARKER_PREFIX)) {
    const log = await execRead(`tail -n 80 ${UPGRADE_PROGRESS_LOG} 2>/dev/null`)
    sBox.stop('upgrade timeout (6 min)')
    note(`log tail:\n${log.slice(-400)}`, 'recoverable')
    return
  }

  // Re-handoff against the SAME endpoint (harness restarted with fresh keypair).
  sBox.message('re-handing off agent privkey to restarted harness')
  const sandboxClient = new SandboxClient({
    endpoint: args.sandboxEndpoint,
    sandboxId: args.sandboxId,
    operator: operatorAccount,
  })
  try {
    await handoffAgentToHarness({
      sandboxClient,
      agentPrivkey: args.agentPrivkey,
      agentAddress: args.agentAddress,
      iNFTRef: { contract: args.contractAddress, tokenId: args.tokenId },
      iNFTNetwork: args.iNFTNetwork,
      brain: args.brain,
      onProgress: msg => sBox.message(msg),
    })
    sBox.stop(`sandbox ${args.sandboxId.slice(0, 8)} ready @ ${args.sandboxEndpoint}`)
  } catch (e) {
    sBox.stop(`handoff failed: ${(e as Error).message.slice(0, 200)}`)
    note(
      [
        'Container code rolled to the new ref but the agent privkey handoff did not complete.',
        'The harness is back in Bootstrapping state. Re-run `anima upgrade` to retry the handoff,',
        'or `anima upgrade --reprovision` to start fresh.',
      ].join('\n'),
      'recoverable',
    )
    return
  }

  outro(
    [
      '',
      `  sandbox       ${args.sandboxId} (unchanged)`,
      `  endpoint      ${args.sandboxEndpoint} (unchanged)`,
      `  ref           ${args.ref}`,
      '',
      'Next: `anima` to chat (same harness endpoint, same agent EOA, new code)',
    ].join('\n'),
  )
}

interface ReprovisionUpgradeArgs {
  operator: OperatorSigner
  agentPrivkey: Hex
  agentAddress: Address
  contractAddress: Address
  tokenId: bigint
  oldSandboxId: string
  config: NonNullable<Awaited<ReturnType<typeof findAndLoadConfig>>>['config']
  loadedPath: string
  ref: string
}

async function runReprovisionUpgrade(args: ReprovisionUpgradeArgs): Promise<void> {
  const operatorAccount = await args.operator.account()
  const provider = new SandboxProviderClient({
    endpoint: SANDBOX_PROVIDER_URL_GALILEO,
    operator: operatorAccount,
  })

  const sDel = spinner()
  sDel.start(`Deleting old sandbox ${args.oldSandboxId}`)
  try {
    await provider.deleteSandbox(args.oldSandboxId)
    sDel.stop(`old sandbox ${args.oldSandboxId.slice(0, 8)} deleted`)
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
      operator: args.operator,
      agentPrivkey: args.agentPrivkey,
      agentAddress: args.agentAddress,
      iNFTRef: { contract: args.contractAddress, tokenId: args.tokenId },
      brain: {
        provider: args.config.brain.provider as Address,
        model: args.config.brain.model ?? '',
      },
      iNFTNetwork: args.config.network,
      name: args.config.subname || 'anima',
      ref: args.ref,
      onProgress: msg => sBox.message(msg),
    })
    sBox.stop(`sandbox ${sandboxResult.sandboxId} ready @ ${sandboxResult.endpoint}`)
  } catch (e) {
    sBox.stop(`re-provision failed: ${(e as Error).message.slice(0, 200)}`)
    note(
      [
        'Old sandbox was deleted but the new one did not provision.',
        'Identity + funds + memory all safe on chain / 0G Storage.',
        'Re-run `anima upgrade --reprovision` after fixing the issue, or `anima deploy` to start fresh.',
      ].join('\n'),
      'recoverable (agent offline)',
    )
    return
  }

  if (args.config.subname) {
    const sEp = spinner()
    sEp.start(`Updating agent:endpoint on ${args.config.subname}.anima.0g`)
    try {
      await publishSandboxEndpoint({
        subname: args.config.subname,
        agentPrivkey: args.agentPrivkey,
        endpoint: sandboxResult.endpoint,
      })
      sEp.stop('agent:endpoint updated')
    } catch (e) {
      sEp.stop(`agent:endpoint update failed: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  const updated = {
    ...args.config,
    sandbox: {
      ...args.config.sandbox,
      id: sandboxResult.sandboxId,
      providerAddress: sandboxResult.providerAddress,
      endpoint: sandboxResult.endpoint,
      snapshotName: sandboxResult.snapshotName,
    },
  }
  await writeConfigTs(args.loadedPath, updated, { subname: updated.subname ?? null })

  outro(
    [
      '',
      `  old sandbox   ${args.oldSandboxId}`,
      `  new sandbox   ${sandboxResult.sandboxId}`,
      `  endpoint      ${sandboxResult.endpoint}`,
      `  ref           ${args.ref}`,
      '',
      'Next: `anima` to chat (now routes through the new harness)',
    ].join('\n'),
  )
}

function sliceBetween(s: string, start: string, end: string): string {
  const i = s.indexOf(start)
  if (i < 0) return ''
  const j = s.indexOf(end, i + start.length)
  if (j < 0) return s.slice(i + start.length)
  return s.slice(i + start.length, j)
}

function sliceAfter(s: string, marker: string): string {
  const i = s.indexOf(marker)
  return i < 0 ? '' : s.slice(i + marker.length)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
