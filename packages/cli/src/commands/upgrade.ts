import { cancel, confirm, intro, isCancel, log, note, outro, spinner } from '@clack/prompts'
import {
  type AnimaNetwork,
  type AnimaPlugin,
  type OperatorSigner,
  SANDBOX_PROVIDER_URL_GALILEO,
  SandboxProviderClient,
  iNFTAgentId,
} from '@s0nderlabs/anima-core'
import {
  type BootstrapMode,
  UPGRADE_DONE_MARKER,
  UPGRADE_FAIL_KEYWORDS,
  UPGRADE_FAIL_MARKER,
  UPGRADE_PROGRESS_LOG,
  UPGRADE_SUCCESS_MARKER_PREFIX,
  buildUpgradeScript,
} from '@s0nderlabs/anima-gateway'
import type { Address, Hex } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import { SandboxClient } from '../sandbox/client'
import { BootstrapProgressController } from '../util/bootstrap-progress-box'
import { resolveCliVersion } from '../util/cli-version'
import { checkTagExists } from '../util/github-releases'
import { loadProfileScopeKeyHex } from '../util/profile-key'
import {
  ANIMA_REPO_URL,
  LATEST_KEYWORD,
  type ResolvedRef,
  expectedVersionFromRef,
  formatResolvedRef,
  resolveAnimaRef,
} from '../util/ref-resolver'
import { loadTelegramHandoffSecrets } from '../util/telegram-secrets'
import { loadOrPickOperatorSigner } from './init/operator-picker'
import {
  ensureSandboxStarted,
  extractExecOutput,
  handoffAgentToGateway,
  makeExecRead,
  preflightProviderDeposit,
  publishSandboxEndpoint,
  runSandboxProvision,
  unlockAgentKeystore,
} from './init/sandbox-provision'

export type UpgradeMode = 'in-place' | 'reprovision'

/**
 * Parse the argv tail (everything AFTER the `upgrade` subcommand token) into
 * {@link UpgradeOpts}. `--ref <val>` takes priority. Otherwise the first
 * non-flag arg becomes the ref, so `anima upgrade latest` and
 * `anima upgrade v0.17.8` work without `--ref`. Empty tail → undefined ref →
 * command flow defaults to `latest` via GitHub API.
 */
export function parseUpgradeArgs(tail: readonly string[]): UpgradeOpts {
  const refIdx = tail.indexOf('--ref')
  const flagRef = refIdx >= 0 ? tail[refIdx + 1] : undefined
  const positionalRef = tail.find(a => !a.startsWith('-') && a !== flagRef)
  return {
    ref: flagRef ?? positionalRef,
    yes: tail.includes('--yes') || tail.includes('-y'),
    reprovision: tail.includes('--reprovision'),
  }
}

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

  const mode: UpgradeMode = opts.reprovision ? 'reprovision' : 'in-place'

  let resolved: ResolvedRef
  try {
    resolved = await resolveAnimaRef(opts.ref)
  } catch (e) {
    cancel(
      `could not resolve ref: ${(e as Error).message.slice(0, 200)}\nGitHub API may be unreachable. Pin a tag with \`--ref vX.Y.Z\` to skip the lookup.`,
    )
    return
  }

  // Pre-flight tag visibility — closes the silent-success bug from 2026-05-03
  // (see upgrade-silent-success-bug.md). Skip when we just resolved from
  // `latest` (the API IS the source of truth) or for branch/SHA refs.
  if (resolved.isTag && !resolved.resolvedFromLatest) {
    try {
      const exists = await checkTagExists(ANIMA_REPO_URL, resolved.ref)
      if (!exists) {
        cancel(
          `Tag ${resolved.ref} is not visible on the remote yet (CI may still be propagating).\nTry again in 30s, or run \`anima upgrade ${LATEST_KEYWORD}\` to pick the most recent published release.`,
        )
        return
      }
    } catch (e) {
      cancel(
        `tag visibility check failed: ${(e as Error).message.slice(0, 200)}\nGitHub API may be unreachable. Set \`ANIMA_BOOTSTRAP_REF=main\` to skip tag verification for dev builds.`,
      )
      return
    }
  }

  const refDisplay = formatResolvedRef(resolved)

  if (!opts.yes) {
    const message =
      mode === 'reprovision'
        ? `Reprovision sandbox ${config.sandbox.id.slice(0, 8)} with a fresh container at ref=${refDisplay}? (~60-90s downtime, ~0.9 0G testnet)`
        : `Upgrade sandbox ${config.sandbox.id.slice(0, 8)} in place to ref=${refDisplay}? (~30-60s downtime)`
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

  // Pre-flight: Galileo deposit balance. The May 2 INSUFFICIENT_BALANCE event
  // archived enigma; refusing up-front with a clear suggestion is much better
  // UX than letting the upgrade run + fail mid-bootstrap.
  if (!(await preflightProviderDeposit(operator))) {
    await operator.close?.()
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
      resolved,
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
      subname: config.subname,
      plugins: config.plugins,
      resolved,
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
  /** Optional .0g subname forwarded into the harness handoff RuntimeConfig. */
  subname?: string | null
  /**
   * Plugins enabled in the local config; threaded into the harness
   * RuntimeConfig so the sandbox loads the same plugin set (telegram listener
   * in particular). Without this the harness defaults to ['system','comms','onchain']
   * and silently drops 'telegram' even when telegram-secrets are provisioned.
   */
  plugins?: AnimaPlugin[]
  resolved: ResolvedRef
}

async function runInPlaceUpgrade(args: InPlaceUpgradeArgs): Promise<void> {
  const operatorAccount = await args.operator.account()
  const provider = new SandboxProviderClient({
    endpoint: SANDBOX_PROVIDER_URL_GALILEO,
    operator: operatorAccount,
  })

  const sBox = spinner()
  sBox.start('Ensuring sandbox is started')
  try {
    await ensureSandboxStarted(provider, args.sandboxId, {
      onProgress: msg => sBox.message(msg),
    })
  } catch (e) {
    sBox.stop(`ensure-started failed: ${(e as Error).message.slice(0, 200)}`)
    note(
      [
        'The sandbox could not be brought to started state.',
        'If state is `error` or restore failed, run `anima upgrade --reprovision` to spin a fresh container.',
      ].join('\n'),
      'recoverable',
    )
    return
  }

  sBox.message('probing container bootstrap mode')
  const probedMode = await probeContainerBootstrapMode(provider, args.sandboxId)
  if (!probedMode) {
    sBox.stop('cannot determine container bootstrap mode (no anima install detected)')
    note(
      [
        'Container has neither $HOME/anima/.git/ nor a global anima-gateway binary.',
        'The container may have been wiped or never bootstrapped successfully.',
        'Try `anima upgrade --reprovision` to spin a fresh container.',
      ].join('\n'),
      'recoverable',
    )
    return
  }
  const cliVersion = probedMode === 'npm' ? await resolveCliVersion() : undefined
  sBox.message(`launching in-place upgrade to ref=${args.resolved.ref} (mode=${probedMode})`)
  const { script } = buildUpgradeScript({
    sandboxId: args.sandboxId,
    operatorAddress: operatorAccount.address,
    mode: probedMode,
    ref: args.resolved.ref,
    packageVersion: cliVersion,
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

  // Post-flight version verification — DONE marker only proves the inner
  // script finished, not that git checkout moved HEAD. Read package.json
  // from the container and compare. Skip for non-tag refs (no expectation).
  const expected = expectedVersionFromRef(args.resolved)
  if (expected !== null) {
    const verifyPath =
      probedMode === 'npm'
        ? '$HOME/.bun/install/global/node_modules/@s0nderlabs/anima-gateway/package.json'
        : '$HOME/anima/packages/gateway/package.json'
    const verifyOut = await execRead(`grep '"version"' ${verifyPath} | head -1`)
    const m = verifyOut.match(/"version"\s*:\s*"([^"]+)"/)
    if (!m) {
      sBox.stop('post-flight verification failed: cannot parse package.json version')
      note(
        [
          'The upgrade reported success but we could not read the deployed package.json.',
          'Re-running `anima upgrade` should land cleanly. If this persists, file an issue.',
        ].join('\n'),
        'recoverable',
      )
      return
    }
    const actual = m[1] ?? ''
    if (actual !== expected) {
      // v0.24.4: when npm `latest` is newer than the github release `latest`
      // tag (common during a ship window where the tag was published seconds
      // before the github release was cut), `npm install @s0nderlabs/anima-cli@latest`
      // pulls a NEWER version than `expected`. Treat newer-than-requested as
      // a soft pass: print a note, continue handoff, don't bail out.
      const cmpNewer = isSemverNewer(actual, expected)
      if (cmpNewer) {
        sBox.message(`harness landed ${actual} (newer than requested ${expected}); continuing`)
      } else {
        sBox.stop(`silent-success regression: expected ${expected}, got ${actual}`)
        note(
          [
            `The harness reported success but is running ${actual} instead of ${expected}.`,
            'This means git fetch may not have seen the tag yet. Re-running',
            `\`anima upgrade --ref ${args.resolved.ref ?? 'latest'}\` should land it correctly,`,
            'or `anima upgrade latest` to pick the most recent published release.',
          ].join('\n'),
          'recoverable',
        )
        return
      }
    } else {
      sBox.message(`verified harness version=${actual}`)
    }
  }

  // Re-handoff against the SAME endpoint (harness restarted with fresh keypair).
  sBox.message('re-handing off agent privkey to restarted harness')
  const sandboxClient = new SandboxClient({
    endpoint: args.sandboxEndpoint,
    sandboxId: args.sandboxId,
    operator: operatorAccount,
  })
  const telegramSecretsPlain = await loadTelegramHandoffSecrets({
    signer: args.operator,
    agentAddress: args.agentAddress,
    contractAddress: args.contractAddress,
    tokenId: args.tokenId,
    onNotice: msg => sBox.message(msg),
  })
  const inPlaceAgentId = iNFTAgentId({
    contractAddress: args.contractAddress,
    tokenId: args.tokenId,
  })
  const inPlaceProfileKeyHex = loadProfileScopeKeyHex(inPlaceAgentId)
  if (!inPlaceProfileKeyHex) {
    sBox.message('no cached PROFILE key; sandbox will boot without profile-slot anchoring')
  }
  try {
    await handoffAgentToGateway({
      sandboxClient,
      agentPrivkey: args.agentPrivkey,
      agentAddress: args.agentAddress,
      iNFTRef: { contract: args.contractAddress, tokenId: args.tokenId },
      iNFTNetwork: args.iNFTNetwork,
      brain: args.brain,
      subname: args.subname,
      plugins: args.plugins,
      telegramSecrets: telegramSecretsPlain,
      profileScopeKeyHex: inPlaceProfileKeyHex,
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
      `  ref           ${formatResolvedRef(args.resolved)}`,
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
  resolved: ResolvedRef
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
  const telegramSecretsPlain = await loadTelegramHandoffSecrets({
    signer: args.operator,
    agentAddress: args.agentAddress,
    contractAddress: args.contractAddress,
    tokenId: args.tokenId,
    onNotice: msg => sBox.message(msg),
  })
  const reprovisionAgentId = iNFTAgentId({
    contractAddress: args.contractAddress,
    tokenId: args.tokenId,
  })
  const reprovisionProfileKeyHex = loadProfileScopeKeyHex(reprovisionAgentId)
  if (!reprovisionProfileKeyHex) {
    sBox.message('no cached PROFILE key; fresh sandbox will boot without profile-slot anchoring')
  }
  let sandboxResult: Awaited<ReturnType<typeof runSandboxProvision>>
  const boxCtl = new BootstrapProgressController({
    spinner: sBox,
    cliVersion: await resolveCliVersion(),
    startedMsg: 'fresh sandbox started, running bootstrap',
  })
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
      ref: args.resolved.ref,
      subname: args.config.subname,
      plugins: args.config.plugins,
      telegramSecrets: telegramSecretsPlain,
      profileScopeKeyHex: reprovisionProfileKeyHex,
      onProgress: boxCtl.onProgress,
      onStageEvent: boxCtl.onStageEvent,
      onTick: boxCtl.onTick,
    })
    boxCtl.finalize(`sandbox ${sandboxResult.sandboxId} ready @ ${sandboxResult.endpoint}`, msg =>
      log.step(msg),
    )
  } catch (e) {
    boxCtl.fail(`re-provision failed: ${(e as Error).message.slice(0, 200)}`, msg => log.error(msg))
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
      `  ref           ${formatResolvedRef(args.resolved)}`,
      '',
      'Next: `anima` to chat (now routes through the new harness)',
    ].join('\n'),
  )
}

/**
 * v0.24.4: compare two semver-shaped strings as `a > b`. Strips a leading `v`
 * if present. Returns true when `a` is strictly newer than `b`. Used by the
 * post-flight verifier so a newer-than-requested install (npm latest > github
 * release latest during a ship window) doesn't fire the "silent-success
 * regression" warning. Lightweight — does not handle prerelease tags.
 */
function isSemverNewer(a: string, b: string): boolean {
  const parse = (s: string): number[] => {
    const clean = s.replace(/^v/, '').split('-')[0] ?? ''
    return clean.split('.').map(p => Number.parseInt(p, 10) || 0)
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0
    const bv = pb[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
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

/**
 * Single execInToolbox round-trip that probes the container's bootstrap mode
 * by checking filesystem state. Returns 'git' if `$HOME/anima/.git/` exists,
 * 'npm' if global anima-gateway binary exists, or null if neither.
 *
 * Used by `runInPlaceUpgrade` so the upgrade script ships only the path it
 * actually needs (auto-detect inside the script blew the 5KB Daytona cap).
 */
export async function probeContainerBootstrapMode(
  provider: SandboxProviderClient,
  sandboxId: string,
): Promise<BootstrapMode | null> {
  // Routed through makeExecRead so the `if [...]; then ...; fi` runs under
  // a real bash. Daytona's exec is argv-only; without the wrap the probe
  // tokenises `if` as argv[0] and returns empty. makeExecRead also swallows
  // exec errors, returning '' on failure — matches the previous catch arm.
  const execRead = makeExecRead(provider, sandboxId)
  const out = await execRead(
    `if [ -d "$HOME/anima/.git" ]; then echo MODE=git; elif [ -x "$HOME/.bun/install/global/node_modules/.bin/anima-gateway" ]; then echo MODE=npm; else echo MODE=none; fi`,
  )
  if (out.includes('MODE=git')) return 'git'
  if (out.includes('MODE=npm')) return 'npm'
  return null
}
