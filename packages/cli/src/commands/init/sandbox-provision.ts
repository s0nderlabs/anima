import { cancel, note } from '@clack/prompts'
import {
  type AnimaNetwork,
  type AnimaPlugin,
  NETWORK_CHAIN_ID,
  type OperatorSigner,
  type PermissionMode,
  SANDBOX_DEFAULT_INITIAL_DEPOSIT_OG,
  SANDBOX_PROVIDER_GALILEO,
  SANDBOX_PROVIDER_URL_GALILEO,
  SANDBOX_TEE_SIGNER_GALILEO,
  SandboxProviderClient,
  type SandboxRecord,
  SandboxSettlementClient,
  SannClient,
  type ToolboxExecResponse,
  agentPaths,
  buildSandboxEndpoint,
  encryptToPubkey,
  fetchAndDecryptKeystore,
  iNFTAgentId,
  subnameNode,
  waitForReceiptResilient,
} from '@s0nderlabs/anima-core'
import {
  BOOTSTRAP_DONE_MARKER,
  BOOTSTRAP_FAIL_KEYWORDS,
  BOOTSTRAP_FAIL_MARKER,
  BOOTSTRAP_PROGRESS_LOG,
  BOOTSTRAP_SUCCESS_MARKER_PREFIX,
  RELAUNCH_DONE_MARKER,
  RELAUNCH_FAIL_MARKER,
  RELAUNCH_PROGRESS_LOG,
  buildBootstrapScript,
  buildGatewayRelaunchScript,
} from '@s0nderlabs/anima-gateway'
import { type Address, type Hex, formatEther, hexToBytes, parseEther } from 'viem'
import type { LocalAccount } from 'viem/accounts'
import { SandboxClient } from '../../sandbox/client'
import { resolveBootstrapMode } from '../../util/bootstrap-mode'
import type { BootstrapStageId, BootstrapStageStatus } from '../../util/bootstrap-progress-box'
import { mapBootstrapMarkerToStage } from '../../util/bootstrap-progress-box'
import { resolveCliVersion } from '../../util/cli-version'
import { withSilencedConsole } from '../../util/silence-console'
import type { TelegramHandoffSecrets } from '../../util/telegram-secrets'

export type { BootstrapStageId, BootstrapStageStatus }

export interface SandboxProvisionOpts {
  /** OperatorSigner. Used for both Galileo settlement txs AND provision sig. */
  operator: OperatorSigner
  /** Decrypted agent privkey (already saved to keystore + uploaded to 0G Storage). */
  agentPrivkey: Hex
  /** Agent EOA derived from privkey. Used in iNFTRef + RuntimeConfig.identity.agent. */
  agentAddress: Address
  /** iNFT identity for the harness's RuntimeConfig. */
  iNFTRef: { contract: Address; tokenId: bigint }
  /** Brain provider + model picked during init. */
  brain: { provider: Address; model: string }
  /** Plugins to load in the harness. Defaults to all 3 first-party. */
  plugins?: AnimaPlugin[]
  /** Optional system-prompt append. */
  promptAppend?: string
  /** Optional .0g subname (e.g. "specter") forwarded into RuntimeConfig so the
   * harness's TG pairing greeting addresses the agent by registered name. */
  subname?: string | null
  /**
   * Optional telegram secrets (botToken + allowlist). Threaded into the
   * secondary ECIES envelope inside `handoffAgentToGateway` so the freshly
   * provisioned harness boots with `listeners.telegram: "active"`. Source
   * via `loadTelegramHandoffSecrets` (util/telegram-secrets.ts).
   */
  telegramSecrets?: TelegramHandoffSecrets
  /**
   * v0.23.1: operator-derived PROFILE scope key (32 bytes hex with 0x prefix).
   * Threaded into the same secondary ECIES envelope as telegramSecrets so the
   * freshly provisioned harness boots with `slots.profile` ready to anchor
   * instead of `{ status: 'skipped', reason: 'no-profile-key' }`. Source via
   * `loadProfileScopeKeyHex` (util/profile-key.ts) when called from upgrade
   * paths; init derives it inline as part of the operator-sign step.
   */
  profileScopeKeyHex?: `0x${string}`
  /** Network the iNFT lives on (mainnet for hybrid path 1). */
  iNFTNetwork: AnimaNetwork
  /** Sandbox name (sent to provider; surfaces in dashboards). */
  name: string
  /** Git tag the bootstrap script clones (e.g. 'v0.15.0'). Used in git mode. */
  ref: string
  /** Override repo URL (defaults to canonical anima repo). Used in git mode. */
  repoUrl?: string
  /**
   * Bootstrap mode: 'git' clones monorepo from GitHub; 'npm' installs
   * @s0nderlabs/anima via `bun add -g`. Defaults to npm (since v0.21.20)
   * because it's ~10x faster (~30-60 sec vs 5-8 min cold start). Falls back
   * to git when ANIMA_BOOTSTRAP_REF is set or ANIMA_BOOTSTRAP_MODE=git
   * (unreleased-code testing). See `resolveBootstrapMode` in
   * `cli/src/util/bootstrap-mode.ts` for the full env resolution.
   */
  mode?: import('@s0nderlabs/anima-gateway').BootstrapMode
  /**
   * Npm mode: exact published version to install (e.g. '0.21.15'). Defaults
   * to the CLI package's own version (so a v0.21.15 CLI deploys a v0.21.15
   * gateway). Ignored in git mode.
   */
  packageVersion?: string
  /** Override snapshot. Default `daytonaio/sandbox:0.5.0-slim`. */
  snapshotName?: string
  /** Initial deposit to provider contract (testnet 0G). Default 1.0 0G. */
  depositOg?: number
  /**
   * GitHub PAT for cloning private anima repo from inside the container.
   * Falls back to `ANIMA_GITHUB_TOKEN` env var. Public repos can leave unset.
   */
  githubToken?: string
  /** Optional progress callback for spinner UX. */
  onProgress?: (msg: string) => void
  /**
   * Structured stage-event callback. When set, the bootstrap phase + /healthz
   * wait emit `(stage, status)` transitions instead of free-text progress
   * messages, so callers can render a boxed multi-line UI. The pre-bootstrap
   * phase (deposit/createSandbox) still uses `onProgress`.
   */
  onStageEvent?: (id: BootstrapStageId, status: BootstrapStageStatus) => void
  /**
   * Periodic tick from the 5s heartbeat during the launchScript upload + poll
   * loop. Lets a box renderer refresh spinner glyphs and elapsed counters
   * between marker transitions.
   */
  onTick?: () => void
}

export interface SandboxProvisionResult {
  sandboxId: string
  endpoint: string
  providerAddress: Address
  snapshotName: string
  agentAddress: Address
  bootstrapPubkey: Hex
  depositTx?: Hex
  acknowledgeTx?: Hex
}

/**
 * Orchestrate the full sandbox-deploy handoff. Used by `anima init --target
 * sandbox`, `anima deploy`, and `anima upgrade`.
 *
 * Steps:
 *   1. Galileo testnet: deposit + acknowledge TEE signer (skip if already done)
 *   2. provider.createSandbox + wait for state=started
 *   3. provider.execInToolbox(bootstrap-script): apt-get install + bun + git
 *      clone + bun install + nohup harness daemon
 *   4. Poll harness /bootstrap/pubkey via nip.io URL
 *   5. ECIES-encrypt agentPrivkey to bootstrap pubkey + EIP-191-sign envelope
 *   6. POST /bootstrap/provision (operator EIP-191 sig over the request hash)
 *   7. Poll /healthz until state=Ready + runtimeReady=true
 *   8. Return sandboxId + endpoint URL for caller to write into config + subname.
 */
export async function runSandboxProvision(
  opts: SandboxProvisionOpts,
): Promise<SandboxProvisionResult> {
  const progress = opts.onProgress ?? (() => {})
  const stageEvent = opts.onStageEvent
  const tick = opts.onTick
  const snapshotName = opts.snapshotName ?? 'daytonaio/sandbox:0.5.0-slim'
  const repoUrl = opts.repoUrl ?? 'https://github.com/s0nderlabs/anima.git'
  const depositWei = parseEther(String(opts.depositOg ?? SANDBOX_DEFAULT_INITIAL_DEPOSIT_OG))

  const operatorAddress = await opts.operator.address()
  const operatorAccount = await opts.operator.account()
  const galileoPublic = await opts.operator.publicClient('0g-testnet')
  const galileoWallet = await opts.operator.walletClient('0g-testnet')

  if (galileoPublic.chain && galileoPublic.chain.id !== NETWORK_CHAIN_ID['0g-testnet']) {
    throw new Error('operator publicClient bound to wrong chain — expected Galileo testnet')
  }

  const settlement = new SandboxSettlementClient({
    publicClient: galileoPublic,
    walletClient: galileoWallet,
  })

  // Reads (deposit balance + TEE ack state) are independent; run in parallel.
  progress('checking provider deposit balance + TEE acknowledgement')
  const [balanceBefore, ackd] = await Promise.all([
    settlement.getBalance(operatorAddress, SANDBOX_PROVIDER_GALILEO),
    settlement.isTEEAcknowledged(operatorAddress, SANDBOX_PROVIDER_GALILEO),
  ])
  let depositTx: Hex | undefined
  if (balanceBefore < depositWei) {
    const need = depositWei - balanceBefore
    progress(`depositing ${formatOg(need)} 0G to provider`)
    depositTx = await settlement.deposit({
      recipient: operatorAddress,
      provider: SANDBOX_PROVIDER_GALILEO,
      amountWei: need,
    })
    await waitForReceiptResilient(galileoPublic, depositTx, { tries: 60, delayMs: 2000 })
  }
  let acknowledgeTx: Hex | undefined
  if (!ackd) {
    progress(`acknowledging TEE signer ${SANDBOX_TEE_SIGNER_GALILEO}`)
    acknowledgeTx = await settlement.acknowledgeTEESigner({
      provider: SANDBOX_PROVIDER_GALILEO,
      acknowledged: true,
    })
    await waitForReceiptResilient(galileoPublic, acknowledgeTx, { tries: 60, delayMs: 2000 })
  }

  // Step 2: createSandbox
  const provider = new SandboxProviderClient({
    endpoint: SANDBOX_PROVIDER_URL_GALILEO,
    operator: operatorAccount,
  })

  progress(`creating sandbox snapshot=${snapshotName}`)
  const created = await createSandboxWithOrphanRetry(provider, snapshotName, opts.name, progress)
  if (!created.id) throw new Error('createSandbox returned no id')
  const sandboxId = created.id

  // Wait for sandbox state=started (~10-30s typical, 120s ceiling).
  progress(`waiting for sandbox ${sandboxId} to start`)
  const startDeadline = Date.now() + 120_000
  let lastState = created.state
  let started = false
  while (Date.now() < startDeadline) {
    const sb = await provider.getSandbox(sandboxId).catch(() => null)
    if (sb?.state) lastState = sb.state
    if (sb?.state === 'started') {
      started = true
      break
    }
    await sleep(2000)
  }
  if (!started) {
    throw new Error(
      `sandbox ${sandboxId} did not reach state=started within 120s (last=${lastState})`,
    )
  }

  // Step 3: launch bootstrap. The script detaches the slow apt+bun+install
  // work into a nohup'd subshell and returns exit 0 in <2s; the Daytona exec
  // 60s cap then doesn't bite. We poll the done/fail markers for actual
  // completion before moving on to /bootstrap/pubkey.
  //
  // For private anima repos, pass a GitHub PAT via ANIMA_GITHUB_TOKEN env (or
  // the explicit `githubToken` opt). Token is embedded in the clone URL inside
  // the bootstrap script. Public repos skip auth entirely.
  const githubToken = opts.githubToken ?? process.env.ANIMA_GITHUB_TOKEN
  const mode = opts.mode ?? resolveBootstrapMode()
  const packageVersion =
    opts.packageVersion ?? (mode === 'npm' ? await resolveCliVersion() : undefined)
  const { script } = buildBootstrapScript({
    sandboxId,
    operatorAddress,
    ref: opts.ref,
    repoUrl,
    githubToken,
    mode,
    packageVersion,
  })
  const installLabel =
    mode === 'npm'
      ? 'apt + bun + npm install + browser deps + harness daemon, ~90-150s'
      : 'apt + bun + git clone + harness daemon, runs ~3-5 min'
  // v0.24.6: ticker keeps the spinner text alive while `execInToolbox` blocks
  // in HTTP retries against Daytona (worst case ~252s = 3 retries x 60s timeout
  // + linear backoff). Without this, the spinner sits on `launching bootstrap`
  // for 30-180s before the poll-loop heartbeat (line 269+) ever runs.
  //
  // v0.24.7: when a stage-event consumer is registered, route the elapsed
  // signal through `onTick()` so the boxed renderer advances its spinner +
  // counters; the legacy text-based path still fires when callbacks are
  // unset (CI / scripted flows).
  const launchLabel = `launching bootstrap (${installLabel})`
  if (stageEvent) {
    stageEvent('launch-upload', 'running')
  } else {
    progress(launchLabel)
  }
  const launchStart = Date.now()
  let launchTickerRunning = true
  ;(async () => {
    while (launchTickerRunning) {
      await sleep(5000)
      if (!launchTickerRunning) break
      if (tick) tick()
      if (!stageEvent) {
        const elapsedSec = Math.round((Date.now() - launchStart) / 1000)
        progress(`${launchLabel}, ${elapsedSec}s elapsed (uploading script)`)
      }
    }
  })().catch(() => {})
  let launchRes: ToolboxExecResponse
  try {
    launchRes = await provider.execInToolbox(sandboxId, { command: script, timeout: 60 })
  } finally {
    launchTickerRunning = false
  }
  if (launchRes.exitCode !== 0) {
    const launchOut = extractExecOutput(launchRes)
    throw new Error(
      `bootstrap launch failed: exitCode=${launchRes.exitCode} output=${launchOut.slice(0, 400)}`,
    )
  }

  // Poll the done/fail markers. Bootstrap runs ~3-8 min depending on the
  // image cache; surface progress every 5s so the operator sees real
  // movement instead of a static spinner.
  if (stageEvent) {
    // Box renderer owns the visual; emit no extra text. The launch-upload
    // row stays "running" until the first STAGE marker arrives.
  } else {
    progress('waiting for bootstrap completion (apt + bun + git clone + harness ready)')
  }
  const bootstrapDeadline = Date.now() + 600_000 // 10 min max
  // Lean poll: cheap `cat` of FAIL + DONE markers, plus a 20-line tail of
  // the progress log so STAGE markers are findable. The progress surfacing
  // logic prefers any `STAGE: ...` line over the raw tail line.
  const execRead = makeExecRead(provider, sandboxId)
  const POLL = `echo --F--; cat ${BOOTSTRAP_FAIL_MARKER} 2>/dev/null; echo --D--; cat ${BOOTSTRAP_DONE_MARKER} 2>/dev/null; echo --P--; tail -n 20 ${BOOTSTRAP_PROGRESS_LOG} 2>/dev/null`
  const bootstrapStart = Date.now()
  let lastDone = ''
  let lastSurfaced = ''
  let pollTick = 0
  while (Date.now() < bootstrapDeadline) {
    pollTick += 1
    const out = await execRead(POLL)
    if (tick) tick()
    const fail = sliceBetween(out, '--F--', '--D--')
    const done = sliceBetween(out, '--D--', '--P--')
    const failKeyword = BOOTSTRAP_FAIL_KEYWORDS.find(k => fail.includes(k))
    if (failKeyword) {
      const log = await execRead(`tail -n 80 ${BOOTSTRAP_PROGRESS_LOG} 2>/dev/null`)
      throw new Error(`bootstrap-failed: ${failKeyword} log-tail=${log.slice(-400)}`)
    }
    if (done.includes(BOOTSTRAP_SUCCESS_MARKER_PREFIX)) {
      lastDone = done
      const pidLine =
        done
          .split('\n')
          .find(l => l.includes(BOOTSTRAP_SUCCESS_MARKER_PREFIX))
          ?.trim() ?? done.trim()
      if (stageEvent) {
        stageEvent('harness-spawn', 'done')
      } else {
        progress(`bootstrap complete (${pidLine})`)
      }
      break
    }
    // v0.24.5: ALWAYS update progress every tick. Prefer a STAGE marker from
    // the log; else fall back to an elapsed-time heartbeat so the spinner
    // never sits silent. v0.24.7: when a stage-event consumer is registered,
    // we promote STAGE transitions to structured events for the box renderer.
    const real = extractBootstrapProgressLine(sliceAfter(out, '--P--'))
    if (real && real !== lastSurfaced) {
      lastSurfaced = real
      if (stageEvent) {
        const stageId = mapBootstrapMarkerToStage(real)
        if (stageId) stageEvent(stageId, 'running')
      } else {
        progress(`bootstrap: ${real}`)
      }
    } else if (!stageEvent) {
      const elapsedSec = Math.round((Date.now() - bootstrapStart) / 1000)
      progress(`bootstrap waiting (${elapsedSec}s elapsed, tick ${pollTick})`)
    }
    await sleep(5000)
  }
  if (!lastDone.includes(BOOTSTRAP_SUCCESS_MARKER_PREFIX)) {
    const log = await execRead(`tail -n 80 ${BOOTSTRAP_PROGRESS_LOG} 2>/dev/null`)
    throw new Error(`bootstrap timeout (10 min): no done marker. log-tail=${log.slice(-400)}`)
  }

  // Steps 4-7: poll /bootstrap/pubkey → ECIES envelope → /bootstrap/provision
  // → /healthz Ready. Shared with `runInPlaceUpgrade` (which skips the
  // sandbox-provisioning steps above and only re-runs this handoff against
  // the same endpoint after harness restart).
  const endpoint = buildSandboxEndpoint({ sandboxId })
  const sandboxClient = new SandboxClient({
    endpoint,
    sandboxId,
    operator: operatorAccount,
  })
  const { bootstrapPubkey } = await handoffAgentToGateway({
    sandboxClient,
    agentPrivkey: opts.agentPrivkey,
    agentAddress: opts.agentAddress,
    iNFTRef: opts.iNFTRef,
    iNFTNetwork: opts.iNFTNetwork,
    brain: opts.brain,
    plugins: opts.plugins,
    promptAppend: opts.promptAppend,
    subname: opts.subname,
    telegramSecrets: opts.telegramSecrets,
    profileScopeKeyHex: opts.profileScopeKeyHex,
    onProgress: progress,
    onStageEvent: stageEvent,
    onTick: tick,
  })

  return {
    sandboxId,
    endpoint,
    providerAddress: SANDBOX_PROVIDER_GALILEO,
    snapshotName,
    agentAddress: opts.agentAddress,
    bootstrapPubkey,
    depositTx,
    acknowledgeTx,
  }
}

/**
 * Post-restart handoff: poll the harness's bootstrap pubkey, encrypt the
 * agent privkey to it via ECIES, EIP-191-sign the provision envelope, then
 * wait until /healthz reports Ready. Used by:
 *
 *  - `runSandboxProvision` after first-cold bootstrap (fresh container path)
 *  - `runInPlaceUpgrade` after harness restart inside an existing container
 *
 * Both paths talk to a `Bootstrapping` harness that has just generated a
 * fresh ephemeral keypair, so the wire-level sequence is identical.
 */
export interface HandoffAgentToGatewayOpts {
  sandboxClient: SandboxClient
  agentPrivkey: Hex
  agentAddress: Address
  iNFTRef: { contract: Address; tokenId: bigint }
  iNFTNetwork: AnimaNetwork
  brain: { provider: Address; model: string }
  plugins?: AnimaPlugin[]
  promptAppend?: string
  /** Optional .0g subname (e.g. "specter") forwarded into RuntimeConfig so the
   * harness's TG pairing greeting addresses the agent by registered name. */
  subname?: string | null
  /**
   * Optional plaintext harness secrets (telegram bot token + allowlist) to
   * ship via a second ECIES envelope. The handoff helper ECIES-encrypts to
   * the bootstrap pubkey same as agentPrivkey. v0.18.2+ harness expects this
   * field; older harnesses ignore it.
   */
  telegramSecrets?: TelegramHandoffSecrets
  /**
   * v0.23.0: operator-derived AES key for the PROFILE iNFT slot (32 bytes,
   * hex-encoded with 0x prefix). Shipped via the same secondary envelope as
   * telegramSecrets. Without it the sandbox skips profile flush + restore;
   * the operator can ship one later via `anima profile init`. v0.23.0+
   * harness picks it up; older harnesses ignore unknown fields.
   */
  profileScopeKeyHex?: `0x${string}`
  /** Default 60_000. */
  pubkeyTimeoutMs?: number
  /** Default 180_000. */
  readyTimeoutMs?: number
  onProgress?: (msg: string) => void
  /** Structured stage events for the boxed progress renderer. */
  onStageEvent?: (id: BootstrapStageId, status: BootstrapStageStatus) => void
  /** Periodic tick (5s) to refresh spinner glyphs. */
  onTick?: () => void
}

export async function handoffAgentToGateway(
  opts: HandoffAgentToGatewayOpts,
): Promise<{ bootstrapPubkey: Hex }> {
  const progress = opts.onProgress ?? (() => {})
  const stageEvent = opts.onStageEvent
  const endpoint = opts.sandboxClient.endpoint

  if (!stageEvent) progress(`polling ${endpoint}/bootstrap/pubkey`)
  const pubkeyRes = await pollPubkey(opts.sandboxClient, opts.pubkeyTimeoutMs ?? 60_000)

  const agentPrivkeyBytes = hexToBytes(opts.agentPrivkey)
  const envelope = encryptToPubkey({
    recipientPubkey: pubkeyRes.pubkeyHex,
    plaintext: agentPrivkeyBytes,
  })
  let secretsEnvelope: import('@s0nderlabs/anima-core').Option3Envelope | undefined
  if (opts.telegramSecrets || opts.profileScopeKeyHex) {
    const secretsPayload: Record<string, unknown> = {}
    if (opts.telegramSecrets) secretsPayload.telegram = opts.telegramSecrets
    if (opts.profileScopeKeyHex) secretsPayload.profileScopeKeyHex = opts.profileScopeKeyHex
    const secretsJson = JSON.stringify(secretsPayload)
    const secretsBytes = new TextEncoder().encode(secretsJson)
    secretsEnvelope = encryptToPubkey({
      recipientPubkey: pubkeyRes.pubkeyHex,
      plaintext: secretsBytes,
    })
    const parts = [
      opts.telegramSecrets && 'telegram',
      opts.profileScopeKeyHex && 'profile-key',
    ].filter(Boolean)
    if (!stageEvent) progress(`shipping ${parts.join(' + ')} via secondary envelope`)
  }

  if (!stageEvent) progress('sending provision envelope to harness')
  const finalPlugins = resolveHandoffPlugins(opts.plugins, Boolean(opts.telegramSecrets))
  const runtimeConfig = {
    network: opts.iNFTNetwork,
    brain: opts.brain,
    identity: {
      iNFT: {
        contract: opts.iNFTRef.contract,
        tokenId: opts.iNFTRef.tokenId.toString(),
      },
      agent: opts.agentAddress,
    },
    plugins: finalPlugins,
    permissions: pickPermissionMode(),
    promptAppend: opts.promptAppend,
    subname: opts.subname,
  }
  await opts.sandboxClient.provision(
    {
      envelope,
      secretsEnvelope,
      iNFTRef: { contract: opts.iNFTRef.contract, tokenId: opts.iNFTRef.tokenId.toString() },
      config: runtimeConfig,
    },
    pubkeyRes.pubkeyHex,
  )

  if (stageEvent) {
    stageEvent('healthz-ready', 'running')
  } else {
    progress(`polling ${endpoint}/healthz for Ready`)
  }
  await opts.sandboxClient.waitReady({ timeoutMs: opts.readyTimeoutMs ?? 180_000 })
  if (stageEvent) stageEvent('healthz-ready', 'done')

  return { bootstrapPubkey: pubkeyRes.pubkeyHex }
}

/**
 * Ensure a sandbox is in `started` state. Handles every Daytona transition:
 *
 *  - `started`            → no-op
 *  - `stopped`            → /start, poll up to 60s
 *  - `archived`/`archiving` → /start, poll up to 5min (filesystem restore from
 *                            object storage takes minutes)
 *  - `restoring`/`starting`/`pulling_snapshot` → poll without re-issuing /start
 *  - `error`              → throws
 *  - any unknown state    → /start, poll up to 5min
 *
 * Pure state-machine wait: no /bootstrap/provision handoff. Use
 * `resumeArchivedSandbox` for the full wake-and-handoff flow.
 *
 * Per the documented Daytona controller (`apps/api/src/sandbox/controllers/
 * sandbox.controller.ts:487`), `/start` is the same endpoint for both
 * `stopped → started` and `archived → restoring → started` transitions.
 */
export interface EnsureSandboxStartedOpts {
  /** Polling tick interval. Default 5000ms. */
  intervalMs?: number
  /** Max time to wait when source state is stopped. Default 60_000ms. */
  stoppedDeadlineMs?: number
  /** Max time to wait when source state is archived/archiving/restoring. Default 300_000ms. */
  archivedDeadlineMs?: number
  /** Progress callback for spinner UX. */
  onProgress?: (msg: string) => void
}

export interface EnsureSandboxStartedResult {
  /** State observed BEFORE we did anything. */
  initialState: string
  /** Whether the sandbox was already started (no /start was issued). */
  alreadyStarted: boolean
  /** Final state observed (always `started` on success). */
  finalState: string
}

const ARCHIVE_LIKE_STATES = new Set(['archived', 'archiving', 'restoring'])

export async function ensureSandboxStarted(
  provider: SandboxProviderClient,
  sandboxId: string,
  opts: EnsureSandboxStartedOpts = {},
): Promise<EnsureSandboxStartedResult> {
  const intervalMs = opts.intervalMs ?? 5000
  const stoppedDeadlineMs = opts.stoppedDeadlineMs ?? 60_000
  const archivedDeadlineMs = opts.archivedDeadlineMs ?? 300_000
  const progress = opts.onProgress ?? (() => {})

  const initial = await provider.getSandbox(sandboxId)
  if (initial.state === 'started') {
    return { initialState: initial.state, alreadyStarted: true, finalState: 'started' }
  }
  if (initial.state === 'error') {
    throw new Error(`sandbox ${sandboxId} is in error state; cannot resume`)
  }

  const isArchiveLike = ARCHIVE_LIKE_STATES.has(initial.state)
  const deadlineMs = isArchiveLike ? archivedDeadlineMs : stoppedDeadlineMs
  const friendly = isArchiveLike ? 'archived' : initial.state

  // Issue /start unless we're already in a transitional state.
  // `restoring`/`starting`/`pulling_snapshot` mean a transition is in flight;
  // re-issuing /start could confuse the state machine.
  const transientStates = new Set(['starting', 'restoring', 'pulling_snapshot'])
  if (!transientStates.has(initial.state)) {
    progress(`sandbox state=${friendly}, calling startSandbox`)
    try {
      await provider.startSandbox(sandboxId)
    } catch (e) {
      throw new Error(`startSandbox(${sandboxId}) failed: ${(e as Error).message.slice(0, 200)}`)
    }
  } else {
    progress(`sandbox state=${initial.state} (in transition, waiting)`)
  }

  const deadline = Date.now() + deadlineMs
  let lastState = initial.state
  while (Date.now() < deadline) {
    const cur = await provider.getSandbox(sandboxId).catch(() => null)
    if (cur) lastState = cur.state
    if (cur?.state === 'started') {
      return { initialState: initial.state, alreadyStarted: false, finalState: 'started' }
    }
    if (cur?.state === 'error') {
      throw new Error(`sandbox ${sandboxId} transitioned to error state during resume`)
    }
    progress(`waiting for state=started (current=${cur?.state ?? 'unknown'})`)
    await sleep(intervalMs)
  }
  throw new Error(
    `sandbox ${sandboxId} did not reach started within ${Math.round(deadlineMs / 1000)}s (last=${lastState})`,
  )
}

/**
 * Drive a sandbox to `state=archived` from any valid starting state.
 * Daytona requires the sandbox be `stopped` before `/archive` is accepted
 * (verified live: `started + /archive` returns 400 "Sandbox is not stopped").
 *
 * Lifecycle handled:
 *   archived                      -> no-op
 *   archiving                     -> wait for archived
 *   stopped                       -> archive + wait
 *   started / starting            -> stop + wait + archive + wait (two-phase)
 *   error                         -> throw
 *
 * Default deadlines per phase: 60s for stop, 5min for archive (Daytona snapshots
 * the filesystem to object storage; verified live to take >60s sometimes).
 * Used by `anima pause` to confirm Daytona acknowledges the full transition.
 */
export interface EnsureSandboxArchivedOpts {
  intervalMs?: number
  /** Stop-phase deadline. Default 60_000ms. */
  stopDeadlineMs?: number
  /** Archive-phase deadline. Default 300_000ms (5 min). */
  archiveDeadlineMs?: number
  /**
   * Legacy alias for stop+archive deadlines. If set, used for both phases.
   * Prefer `stopDeadlineMs` / `archiveDeadlineMs` for asymmetric tuning.
   */
  deadlineMs?: number
  onProgress?: (msg: string) => void
}

export interface EnsureSandboxArchivedResult {
  initialState: string
  alreadyArchived: boolean
  finalState: string
  /** True if the sandbox had to be stopped first (started → stopped → archived). */
  stoppedFirst: boolean
}

export async function ensureSandboxArchived(
  provider: SandboxProviderClient,
  sandboxId: string,
  opts: EnsureSandboxArchivedOpts = {},
): Promise<EnsureSandboxArchivedResult> {
  const intervalMs = opts.intervalMs ?? 5000
  const stopDeadlineMs = opts.stopDeadlineMs ?? opts.deadlineMs ?? 60_000
  const archiveDeadlineMs = opts.archiveDeadlineMs ?? opts.deadlineMs ?? 300_000
  const progress = opts.onProgress ?? (() => {})

  const initial = await provider.getSandbox(sandboxId)
  if (initial.state === 'archived') {
    return {
      initialState: 'archived',
      alreadyArchived: true,
      finalState: 'archived',
      stoppedFirst: false,
    }
  }
  if (initial.state === 'error') {
    throw new Error(`sandbox ${sandboxId} is in error state; cannot archive`)
  }

  // Phase 1: stop the sandbox if it's currently running.
  // Daytona refuses `/archive` unless state=stopped (returns 400 "Sandbox is
  // not stopped"). `started`/`starting`/`stopping` all need to land on
  // `stopped` before we can issue `/archive`.
  let stoppedFirst = false
  const needsStop = initial.state === 'started' || initial.state === 'starting'
  if (needsStop) {
    stoppedFirst = true
    progress(`sandbox state=${initial.state}, calling stopSandbox`)
    try {
      await provider.stopSandbox(sandboxId)
    } catch (e) {
      throw new Error(`stopSandbox(${sandboxId}) failed: ${(e as Error).message.slice(0, 200)}`)
    }
    const stopDeadline = Date.now() + stopDeadlineMs
    while (Date.now() < stopDeadline) {
      const cur = await provider.getSandbox(sandboxId).catch(() => null)
      if (cur?.state === 'stopped') break
      if (cur?.state === 'error') {
        throw new Error(`sandbox ${sandboxId} transitioned to error during stop`)
      }
      progress(`waiting for state=stopped (current=${cur?.state ?? 'unknown'})`)
      await sleep(intervalMs)
    }
    const afterStop = await provider.getSandbox(sandboxId)
    if (afterStop.state !== 'stopped') {
      throw new Error(
        `sandbox ${sandboxId} did not reach stopped within ${Math.round(stopDeadlineMs / 1000)}s (last=${afterStop.state})`,
      )
    }
  }

  // Phase 2: archive the (now-)stopped sandbox.
  // Skip the call if a previous archive is already in flight.
  const stateBeforeArchive = stoppedFirst ? 'stopped' : (await provider.getSandbox(sandboxId)).state
  if (stateBeforeArchive !== 'archiving') {
    progress(`sandbox state=${stateBeforeArchive}, calling archiveSandbox`)
    try {
      await provider.archiveSandbox(sandboxId)
    } catch (e) {
      throw new Error(`archiveSandbox(${sandboxId}) failed: ${(e as Error).message.slice(0, 200)}`)
    }
  } else {
    progress('sandbox state=archiving (in transition, waiting)')
  }

  const archiveDeadline = Date.now() + archiveDeadlineMs
  let lastState = stateBeforeArchive
  while (Date.now() < archiveDeadline) {
    const cur = await provider.getSandbox(sandboxId).catch(() => null)
    if (cur) lastState = cur.state
    if (cur?.state === 'archived') {
      return {
        initialState: initial.state,
        alreadyArchived: false,
        finalState: 'archived',
        stoppedFirst,
      }
    }
    if (cur?.state === 'error') {
      throw new Error(`sandbox ${sandboxId} transitioned to error during archive`)
    }
    progress(`waiting for state=archived (current=${cur?.state ?? 'unknown'})`)
    await sleep(intervalMs)
  }
  throw new Error(
    `sandbox ${sandboxId} did not reach archived within ${Math.round(archiveDeadlineMs / 1000)}s (last=${lastState})`,
  )
}

/**
 * Wake a stopped/archived sandbox AND re-handoff the agent privkey to the
 * (newly restarted) harness. Idempotent: if the harness is already Ready
 * with the correct agentAddress, returns without re-handoff.
 *
 * Used by `anima resume` (operator wakes their agent) and `runInPlaceUpgrade`
 * after the upgrade-script restarts the harness in place.
 */
export interface ResumeArchivedSandboxOpts {
  provider: SandboxProviderClient
  sandboxId: string
  sandboxEndpoint: string
  operatorAccount: LocalAccount
  agentPrivkey: Hex
  agentAddress: Address
  iNFTRef: { contract: Address; tokenId: bigint }
  iNFTNetwork: AnimaNetwork
  brain: { provider: Address; model: string }
  plugins?: AnimaPlugin[]
  promptAppend?: string
  /** Optional .0g subname (e.g. "specter") forwarded into RuntimeConfig so the
   * harness's TG pairing greeting addresses the agent by registered name. */
  subname?: string | null
  /**
   * Optional plaintext Telegram secrets (bot token + allowlist) shipped via
   * a secondary ECIES envelope so the resumed harness can re-attach the
   * grammY listener. Without this, every pause→resume cycle silently strips
   * the TG bot — the gateway daemon comes back up with `plugins: ['telegram']`
   * but no token, and `build-runtime.ts` skips listener registration. The
   * `runResume` CLI loads this from `loadTelegramSecrets`; programmatic
   * callers may pass `undefined` to keep the harness TG-less.
   */
  telegramSecrets?: TelegramHandoffSecrets
  /**
   * v0.23.1: operator-derived PROFILE scope key (32 bytes hex with 0x prefix).
   * Threaded into the same secondary ECIES envelope as telegramSecrets so the
   * resumed harness boots with `slots.profile` ready to anchor. Source via
   * `loadProfileScopeKeyHex` (util/profile-key.ts). Without it the resumed
   * daemon comes back with `slots.profile = no-profile-key` until the operator
   * re-runs `anima profile init`.
   */
  profileScopeKeyHex?: `0x${string}`
  onProgress?: (msg: string) => void
  ensureStartedOpts?: EnsureSandboxStartedOpts
}

export interface ResumeArchivedSandboxResult {
  initialState: string
  alreadyReady: boolean
  bootstrapPubkey?: Hex
}

export async function resumeArchivedSandbox(
  opts: ResumeArchivedSandboxOpts,
): Promise<ResumeArchivedSandboxResult> {
  const progress = opts.onProgress ?? (() => {})
  const sandboxClient = new SandboxClient({
    endpoint: opts.sandboxEndpoint,
    sandboxId: opts.sandboxId,
    operator: opts.operatorAccount,
  })

  const ensureResult = await ensureSandboxStarted(opts.provider, opts.sandboxId, {
    ...opts.ensureStartedOpts,
    onProgress: progress,
  })

  // Fast-path: if the sandbox was already started, the harness MAY be Ready
  // with the correct agentAddress already; skip the re-handoff cost in that case.
  if (ensureResult.alreadyStarted) {
    const h = await sandboxClient.health().catch(() => null)
    if (
      h?.state === 'Ready' &&
      h.runtimeReady &&
      h.agentAddress?.toLowerCase() === opts.agentAddress.toLowerCase()
    ) {
      progress('harness already Ready with matching agent; skipping handoff')
      return { initialState: ensureResult.initialState, alreadyReady: true }
    }
  }

  // The harness daemon may be missing in two scenarios:
  //   1. archive→restore: Daytona kills every process when archiving, restore
  //      brings filesystem back but no daemons.
  //   2. orphaned `started` sandbox where the harness died for some reason and
  //      Daytona didn't notice (the container is up, the process isn't).
  // Probe /bootstrap/pubkey; if no response, fire the relaunch script.
  progress('checking if harness daemon is alive')
  const gatewayUp = await probeGatewayAlive(opts.sandboxEndpoint, 8_000)
  if (!gatewayUp) {
    progress('harness daemon unreachable; relaunching via toolbox exec')
    await relaunchGatewayDaemon({
      provider: opts.provider,
      sandboxId: opts.sandboxId,
      sandboxEndpoint: opts.sandboxEndpoint,
      operatorAddress: opts.operatorAccount.address,
      onProgress: progress,
    })
  }

  // Re-handoff: pubkey + envelope + provision + waitReady.
  progress('re-handing off agent privkey to harness')
  const { bootstrapPubkey } = await handoffAgentToGateway({
    sandboxClient,
    agentPrivkey: opts.agentPrivkey,
    agentAddress: opts.agentAddress,
    iNFTRef: opts.iNFTRef,
    iNFTNetwork: opts.iNFTNetwork,
    brain: opts.brain,
    plugins: opts.plugins,
    promptAppend: opts.promptAppend,
    subname: opts.subname,
    telegramSecrets: opts.telegramSecrets,
    profileScopeKeyHex: opts.profileScopeKeyHex,
    onProgress: progress,
  })

  return { initialState: ensureResult.initialState, alreadyReady: false, bootstrapPubkey }
}

async function probeGatewayAlive(endpoint: string, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(`${endpoint}/bootstrap/pubkey`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return r.ok
  } catch {
    return false
  }
}

interface RelaunchGatewayOpts {
  provider: SandboxProviderClient
  sandboxId: string
  sandboxEndpoint: string
  operatorAddress: Address
  onProgress?: (msg: string) => void
}

async function relaunchGatewayDaemon(opts: RelaunchGatewayOpts): Promise<void> {
  const progress = opts.onProgress ?? (() => {})
  const { script } = buildGatewayRelaunchScript({
    sandboxId: opts.sandboxId,
    operatorAddress: opts.operatorAddress,
  })

  // Fire the relaunch script via the toolbox. The script forks the inner
  // launcher into the background and returns immediately, so this exec
  // completes in ~1s; the actual harness daemon comes up over the next
  // ~10-15 seconds. Caller polls /bootstrap/pubkey to confirm.
  const fired = await opts.provider
    .execInToolbox(opts.sandboxId, { command: script, timeout: 30 })
    .catch(e => ({
      exitCode: -1,
      result: (e as Error).message,
      stdout: undefined as string | undefined,
    }))
  if (fired.exitCode !== 0) {
    throw new Error(
      `relaunch exec failed: exitCode=${fired.exitCode} ${(fired.result ?? fired.stdout ?? '').slice(0, 160)}`,
    )
  }

  const exec = makeExecRead(opts.provider, opts.sandboxId)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await probeGatewayAlive(opts.sandboxEndpoint, 4_000)) {
      progress('harness daemon back online')
      return
    }
    const failBody = (await exec(`cat ${RELAUNCH_FAIL_MARKER} 2>/dev/null || true`)).trim()
    if (failBody) {
      const tail = (await exec(`tail -n 60 ${RELAUNCH_PROGRESS_LOG} 2>/dev/null || true`)).trim()
      throw new Error(`relaunch failed: ${failBody}\n${tail.slice(0, 600)}`)
    }
    const doneBody = (await exec(`cat ${RELAUNCH_DONE_MARKER} 2>/dev/null || true`)).trim()
    if (doneBody) progress(`relaunch marker: ${doneBody}`)
    progress('waiting for harness daemon to come up')
    await sleep(3_000)
  }
  throw new Error('harness daemon did not come back online within 60s after relaunch')
}

/**
 * Read tool output from Daytona's `process/execute` endpoint, normalizing
 * the `{exitCode, result}` (older docs claimed `{stdout, stderr}` but live
 * runs return `result` for the combined stream). Wraps the command in
 * `bash -c '<cmd>'` so pipes / redirects / `2>/dev/null` work — Daytona's
 * exec splits argv-style without a shell.
 *
 * Used by the bootstrap poll loop, deploy/upgrade flows, and `anima logs`
 * sandbox-mode tail.
 */
export function makeExecRead(
  provider: SandboxProviderClient,
  sandboxId: string,
): (cmd: string) => Promise<string> {
  return async (cmd: string) => {
    const r = await provider
      .execInToolbox(sandboxId, { command: `bash -c '${cmd}'`, timeout: 30 })
      .catch(() => null)
    return r ? extractExecOutput(r) : ''
  }
}

/**
 * Pull combined stdout from a ToolboxExecResponse regardless of which shape
 * the provider returned. Prefers `result` (Daytona's actual format); falls
 * back to `stdout || stderr` for older endpoints.
 */
export function extractExecOutput(r: ToolboxExecResponse): string {
  if (typeof r.result === 'string') return r.result
  return r.stdout ?? r.stderr ?? ''
}

/**
 * Resolve the runtime plugin list for a sandbox handoff. Auto-includes
 * `'telegram'` when telegram secrets are being shipped via the secondary
 * envelope; otherwise `build-runtime.ts` would gate the listener on
 * `pluginNames.includes('telegram')` and skip registration. Default base:
 * `['system', 'comms', 'onchain']`. Idempotent.
 */
export function resolveHandoffPlugins(
  caller: AnimaPlugin[] | undefined,
  shipsTelegramSecrets: boolean,
): AnimaPlugin[] {
  const base = caller ?? (['system', 'comms', 'onchain'] satisfies AnimaPlugin[])
  if (!shipsTelegramSecrets) return base
  if (base.includes('telegram')) return base
  return [...base, 'telegram']
}

/**
 * Pull the most informative progress line from a chunk of the bootstrap log.
 *
 * v0.24.4: bootstrap.ts emits explicit `STAGE: ...` markers before each major
 * step (apt update, apt install, bun install, anima install, browser deps,
 * harness launch). If any tail line starts with `STAGE: ` we prefer that
 * (last-wins, prefix stripped) so the operator sees the current stage instead
 * of whichever raw `[$(date) ...]` log line happened to land last. Falls back
 * to the existing filter/pop heuristic when no STAGE marker is present (older
 * gateway versions, or the gap between bootstrap-start and the first STAGE).
 */
export function extractBootstrapProgressLine(tail: string): string | undefined {
  const lines = tail.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? ''
    if (line.startsWith('STAGE: ')) return line.slice('STAGE: '.length)
  }
  return (
    lines
      .filter(l => !l.includes('setlocale'))
      .pop()
      ?.trim() || undefined
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

async function pollPubkey(
  client: SandboxClient,
  timeoutMs: number,
): Promise<Awaited<ReturnType<SandboxClient['pubkey']>>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await client.pubkey()
    } catch {
      await sleep(2000)
    }
  }
  throw new Error(`/bootstrap/pubkey did not respond within ${timeoutMs}ms`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * createSandbox + 409-orphan recovery. The Daytona provider rejects new
 * sandbox names that already exist with HTTP 409. This bites whenever a
 * prior `anima init` / `anima deploy` partially succeeded (sandbox created
 * but bootstrap failed) and the operator retries: the orphan is still on
 * the provider holding the name. Catch the 409 once, list-by-name + delete
 * the orphan, then retry create. Keeps OOB clean without exposing operators
 * to raw provider API or a manual cleanup CLI.
 */
export async function createSandboxWithOrphanRetry(
  provider: Pick<SandboxProviderClient, 'createSandbox' | 'listSandboxes' | 'deleteSandbox'>,
  snapshot: string,
  name: string | undefined,
  progress: (m: string) => void,
): Promise<SandboxRecord> {
  try {
    return await provider.createSandbox({ snapshot, name })
  } catch (e) {
    const msg = (e as Error).message
    if (!name || !/\b409\b/.test(msg) || !/already exists/i.test(msg)) {
      throw e
    }
    progress(`sandbox name '${name}' collides with an orphan; cleaning up + retrying`)
    const orphans = (await provider.listSandboxes().catch(() => [])).filter(s => s.name === name)
    if (orphans.length === 0) throw e
    for (const o of orphans) {
      await provider.deleteSandbox(o.id).catch(() => {})
    }
    return await provider.createSandbox({ snapshot, name })
  }
}

function formatOg(wei: bigint): string {
  const og = Number(wei) / 1e18
  return og.toFixed(4)
}

/** ANIMA_PERMISSIONS env override; unknown / unset → `off` (autonomous default). */
export function pickPermissionMode(): PermissionMode {
  const raw = process.env.ANIMA_PERMISSIONS?.trim().toLowerCase()
  if (raw === 'prompt' || raw === 'strict' || raw === 'off') return raw
  return 'off'
}

/**
 * Pre-flight check on the operator's Galileo provider deposit. The May 2 2026
 * enigma archive was caused by this balance dropping below `min_balance` mid
 * settlement, so the safe floor is 2× min_balance (= 0.12 0G). Returns true
 * if the operator may proceed; returns false (and surfaces a `cancel(...)`
 * with a `topup --sandbox` suggestion) otherwise.
 *
 * Best-effort: a chain RPC failure surfaces as a `note` warning and returns
 * true (don't block on read failures).
 */
export async function preflightProviderDeposit(operator: OperatorSigner): Promise<boolean> {
  try {
    const operatorAddress = await operator.address()
    const galileoPublic = await operator.publicClient('0g-testnet')
    const settle = new SandboxSettlementClient({ publicClient: galileoPublic })
    const balance = await settle.getBalance(operatorAddress, SANDBOX_PROVIDER_GALILEO)
    const safeFloor = parseEther('0.12')
    if (balance < safeFloor) {
      cancel(
        [
          `Galileo provider deposit ${formatEther(balance)} 0G is below safe threshold (0.12 0G).`,
          'Run `anima topup --sandbox 1` to deposit 1 0G first (~11h runway).',
        ].join('\n'),
      )
      return false
    }
    return true
  } catch (e) {
    note(
      `pre-flight balance check failed: ${(e as Error).message.slice(0, 120)}`,
      'continuing without check',
    )
    return true
  }
}

/**
 * Decrypt the agent keystore via the operator wallet. Used by both
 * `anima deploy` (Local→Sandbox migration) and `anima upgrade` (re-handoff
 * to a new container). The keystore lives encrypted on 0G Storage; the
 * operator's signature derives the AEAD key (Phase 6.6).
 */
export async function unlockAgentKeystore(params: {
  operator: OperatorSigner
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  agentAddress: Address
}): Promise<Hex> {
  const agentId = iNFTAgentId({
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
  })
  const paths = agentPaths.agent(agentId)
  const decrypted = await withSilencedConsole(() =>
    fetchAndDecryptKeystore({
      network: params.network,
      contractAddress: params.contractAddress,
      tokenId: params.tokenId,
      signer: params.operator,
      agentAddress: params.agentAddress,
      cachePath: paths.keystore,
    }),
  )
  return decrypted.privkeyHex
}

/**
 * Publish or update the `agent:endpoint` text record on the agent's
 * `<subname>.anima.0g`. Idempotent: writes the latest endpoint URL each
 * call. Best-effort — caller decides whether to surface the failure.
 */
export async function publishSandboxEndpoint(params: {
  subname: string
  agentPrivkey: Hex
  endpoint: string
}): Promise<Hex> {
  return withSilencedConsole(async () => {
    const sann = new SannClient({ privkeyHex: params.agentPrivkey })
    const tx = await sann.setText(subnameNode(params.subname), 'agent:endpoint', params.endpoint)
    await sann.waitForReceipt(tx)
    return tx
  })
}
