import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
  spinner,
  text,
} from '@clack/prompts'
import {
  type AnimaNetwork,
  AnimaRegistrarClient,
  NETWORK_CHAIN_ID,
  NETWORK_RPC,
  OPERATOR_BLOB_SCOPES,
  type OperatorSessionKeys,
  SannClient,
  agentPaths,
  buildOperatorSession,
  defineConfig,
  derivePubkeyHex,
  explorerTokenUrl,
  explorerTxUrl,
  generateAgentWallet,
  getGasPriceWithFloor,
  iNFTAgentId,
  isLabelTaken,
  mainnetReadOnlyClient,
  mintAgent,
  openComputeLedger,
  placeholderAgentId,
  precomputeAllScopes,
  saveKeystoreLocally,
  subnameNode,
  uploadAndAnchorKeystore,
  validateSubnameLabel,
  waitForReceiptResilient,
  writeOperatorSession,
} from '@s0nderlabs/anima-core'
import { type Address, type Hex, formatEther, hexToBytes, parseEther } from 'viem'
import { writeConfigTs } from '../config/render'
import { BootstrapProgressController } from '../util/bootstrap-progress-box'
import { resolveCliVersion } from '../util/cli-version'
import { withSilencedConsole } from '../util/silence-console'
import { loadTelegramHandoffSecrets } from '../util/telegram-secrets'
import { estimateCosts, renderCostSummary } from './init/cost'
import { fundingGate } from './init/funding-gate'
import { pickBrainModel } from './init/model-picker'
import { pickOperatorSigner } from './init/operator-picker'
import { type SandboxProvisionResult, runSandboxProvision } from './init/sandbox-provision'
import { initialWizardState, updateWizardState, writeWizardState } from './init/wizard-state'

export async function runInit(opts?: { cwd?: string; resume?: boolean }): Promise<void> {
  const configPath = agentPaths.config

  intro('anima init')

  if (existsSync(configPath) && !opts?.resume) {
    const choice = (await select({
      message: `${configPath} exists`,
      options: [
        { value: 'overwrite', label: 'Start fresh (overwrite)' },
        { value: 'cancel', label: 'Cancel' },
      ],
      initialValue: 'cancel',
    })) as 'overwrite' | 'cancel' | symbol
    if (isCancel(choice) || choice === 'cancel') {
      cancel('Aborted.')
      return
    }
  }

  // ─── Phase A: local prompts (no chain, no wallet) ───────────────────────

  const network = (await select({
    message: 'Which 0G network?',
    options: [
      { value: '0g-mainnet' as AnimaNetwork, label: '0G mainnet (16661)' },
      { value: '0g-testnet' as AnimaNetwork, label: '0G Galileo testnet (16602)' },
    ],
    initialValue: '0g-mainnet' as AnimaNetwork,
  })) as AnimaNetwork
  if (isCancel(network)) {
    cancel('Aborted.')
    return
  }

  // Phase A.5 (Phase 11): pick deploy target. local = harness on this machine
  // while CLI runs; sandbox = harness in 0G Sandbox TDX TEE on Galileo testnet
  // (Hybrid Path 1 — iNFT/wallet/Storage/Compute on mainnet, container on
  // Galileo). Sandbox mode requires the operator to also hold testnet 0G for
  // the provider deposit (~1 0G initial, ~0.09 0G/hour burn; free via faucet).
  const deployTarget = (await select({
    message: 'Where will this agent run?',
    options: [
      {
        value: 'local' as const,
        label: 'Local (this machine, always-on while CLI is open)',
      },
      {
        value: 'sandbox' as const,
        label: '0G Sandbox (Galileo TDX TEE, persistent)',
        hint: 'free testnet 0G via faucet (~1 0G initial, ~0.09 0G/h burn)',
      },
    ],
    initialValue: 'local',
  })) as 'local' | 'sandbox' | symbol
  if (isCancel(deployTarget)) {
    cancel('Aborted.')
    return
  }

  const requestedSubname = (await text({
    message: 'Subname under anima.0g (leave blank to skip)',
    placeholder: 'e.g. alice',
    validate: v => {
      if (!v) return undefined
      const r = validateSubnameLabel(v)
      return r.ok ? undefined : `Subname invalid: ${r.reason ?? 'rejected'}`
    },
  })) as string | symbol
  if (isCancel(requestedSubname)) {
    cancel('Aborted.')
    return
  }

  if (requestedSubname) {
    const sAvail = spinner()
    sAvail.start(`Checking ${requestedSubname}.anima.0g availability on mainnet`)
    try {
      const taken = await isLabelTaken(mainnetReadOnlyClient(), requestedSubname)
      if (taken) {
        sAvail.stop(`${requestedSubname}.anima.0g is already claimed`)
        cancel('Pick a different subname and re-run.')
        return
      }
      sAvail.stop(`${requestedSubname}.anima.0g is available`)
    } catch (e) {
      sAvail.stop(`availability check failed: ${(e as Error).message.slice(0, 80)}`)
      const proceedAnyway = await confirm({
        message: 'Availability check failed. Proceed anyway?',
        initialValue: false,
      })
      if (isCancel(proceedAnyway) || !proceedAnyway) {
        cancel('Aborted.')
        return
      }
    }
  }

  const modelPick = await pickBrainModel({ network })
  if (!modelPick) {
    const keepGoing = await confirm({
      message: 'Model catalog unavailable; continue and pick later?',
      initialValue: true,
    })
    if (isCancel(keepGoing) || !keepGoing) {
      cancel('Aborted.')
      return
    }
  }

  const ledgerChoice = (await select({
    message: 'How much to deposit in your compute ledger?',
    options: [
      {
        value: 3,
        label: 'Starter  3 0G',
        hint: 'contract minimum, just trying it',
      },
      {
        value: 10,
        label: 'Standard 10 0G',
        hint: 'comfortable first-month runway',
      },
      {
        value: 30,
        label: 'Extended 30 0G',
        hint: 'multi-month float, heavy users',
      },
      { value: -1, label: 'Custom' },
    ],
    initialValue: 10,
  })) as number | symbol
  if (isCancel(ledgerChoice)) {
    cancel('Aborted.')
    return
  }
  let ledgerSize: number = ledgerChoice as number
  if (ledgerSize === -1) {
    const custom = (await text({
      message: 'Custom deposit amount (0G, minimum 3)',
      placeholder: '10',
      validate: v => {
        const n = Number(v)
        if (!Number.isFinite(n)) return 'Must be a number.'
        if (n < 3) return 'Minimum 3 0G (contract enforced).'
        return undefined
      },
    })) as string | symbol
    if (isCancel(custom)) {
      cancel('Aborted.')
      return
    }
    ledgerSize = Number(custom)
  }

  // ─── Phase B: wallet gate ────────────────────────────────────────────────

  const picked = await pickOperatorSigner({ network })
  if (!picked) return
  const { signer: operator, hint: operatorHint } = picked

  const sConnect = spinner()
  sConnect.start(`Connecting via ${operator.source}`)
  let operatorAddress: Address
  try {
    operatorAddress = await operator.address()
    sConnect.stop(`operator: ${operatorAddress}`)
  } catch (e) {
    sConnect.stop(`connection failed: ${(e as Error).message.slice(0, 140)}`)
    await operator.close?.()
    return
  }

  const costs = estimateCosts({
    ledgerSizeOg: ledgerSize,
    withSubname: !!requestedSubname,
    deployTarget: deployTarget as 'local' | 'sandbox',
  })
  note(renderCostSummary(costs), 'cost summary (0G ~$0.50)')

  const publicClient = await operator.publicClient(network)
  const operatorBalance = await publicClient.getBalance({ address: operatorAddress })

  let skipLedger = false
  if (operatorBalance < costs.totalOperator) {
    const need = costs.totalOperator - operatorBalance
    note(
      `Operator balance ${formatEther(operatorBalance)} 0G, need ${formatEther(need)} 0G more.`,
      'insufficient funds',
    )
    const gate = await fundingGate({
      publicClient,
      operatorAddress,
      requiredOg: costs.totalOperator,
    })
    if (gate.kind === 'cancel') {
      await operator.close?.()
      return
    }
    if (gate.kind === 'skip-ledger') skipLedger = true
  }

  const proceed = await confirm({ message: 'Proceed?', initialValue: true })
  if (isCancel(proceed) || !proceed) {
    cancel('Aborted.')
    await operator.close?.()
    return
  }

  // ─── Phase C: execute with Pattern B state tracking ─────────────────────

  const agent = generateAgentWallet()
  const provisionalAgentId = placeholderAgentId(agent.address)
  const provisional = agentPaths.agent(provisionalAgentId)
  await mkdir(provisional.dir, { recursive: true })

  await writeWizardState(provisional.dir, {
    ...initialWizardState(agent.address, network),
  })

  let mintedTokenId: bigint | null = null
  let contractAddress: Address | null = null

  const sMint = spinner()
  sMint.start(`Minting iNFT on ${network} (keystore slot left as bootstrap until upload)`)
  try {
    const { result, contractAddress: c } = await withSilencedConsole(() =>
      mintAgent({
        network,
        operator,
        agentAddress: agent.address as Address,
      }),
    )
    mintedTokenId = result.tokenId
    contractAddress = c
    await updateWizardState(provisional.dir, draft => {
      draft.steps.mintedTokenId = result.tokenId.toString()
      draft.steps.mintedContract = c
      draft.steps.mintTx = result.txHash
    })
    sMint.stop(
      `iNFT #${result.tokenId.toString()} minted to ${operatorAddress} → ${explorerTxUrl(network, result.txHash)}`,
    )
  } catch (e) {
    sMint.stop(`mint failed: ${(e as Error).message}`)
    await updateWizardState(provisional.dir, draft => {
      draft.lastError = `mint failed: ${(e as Error).message}`
    })
    await operator.close?.()
    return
  }

  const finalAgentId = iNFTAgentId({ contractAddress: contractAddress!, tokenId: mintedTokenId! })
  const targetDir = agentPaths.agent(finalAgentId).dir
  if (provisional.dir !== targetDir) {
    try {
      await rename(provisional.dir, targetDir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  const paths = agentPaths.agent(finalAgentId)

  // v0.23.1: derive BOTH operator-scope keys (keystore + profile) in parallel
  // up front, then reuse them everywhere. This is the single "two signatures
  // back to back" moment in the wizard: keystore scope (for the encrypted
  // privkey blob) + profile scope (for the operator-private user-partition
  // memory slot). Folding profile derivation into init removes the v0.23.0
  // need for `anima profile init` as a follow-up command.
  const sKeys = spinner()
  sKeys.start('Deriving operator scope keys (may prompt twice: keystore + profile)')
  let operatorKeys: OperatorSessionKeys
  let keystoreKeyBuf: Buffer
  let profileScopeKeyHex: `0x${string}` | undefined
  try {
    operatorKeys = await precomputeAllScopes(operator, agent.address as Address, [
      OPERATOR_BLOB_SCOPES.PROFILE,
    ])
    keystoreKeyBuf = Buffer.from(hexToBytes(operatorKeys.keystore))
    const profileHex = operatorKeys[OPERATOR_BLOB_SCOPES.PROFILE]
    profileScopeKeyHex = profileHex as `0x${string}` | undefined
    sKeys.stop('scope keys derived')
  } catch (e) {
    sKeys.stop(`scope key derive failed: ${(e as Error).message.slice(0, 160)}`)
    cancel('Aborted (operator signature required for keystore + profile scopes).')
    await operator.close?.()
    return
  }

  // Pass the already-derived keystoreKey so saveKeystoreLocally skips
  // signing again. Save BEFORE funding the agent EOA per
  // `feedback-init-must-save-keystore-before-funding.md`.
  const sLocal = spinner()
  sLocal.start('Encrypting agent keystore to operator wallet (local insurance)')
  let encryptedBytes: Uint8Array
  try {
    const saved = await saveKeystoreLocally({
      agentAddress: agent.address as Address,
      agentPrivkey: agent.privkeyHex as Hex,
      cachePath: paths.keystore,
      precomputedKey: keystoreKeyBuf,
    })
    encryptedBytes = saved.bytes
    await updateWizardState(paths.dir, draft => {
      draft.steps.keystoreSaved = true
    })
    sLocal.stop(`keystore saved locally at ${paths.keystore}`)
  } catch (e) {
    sLocal.stop(`local keystore save failed: ${(e as Error).message.slice(0, 120)}`)
    cancel('Aborted before funding (keystore encryption failed).')
    await operator.close?.()
    return
  }

  const sFund = spinner()
  const fundingAmount = parseEther('0.1') + parseEther(String(ledgerSize))
  sFund.start(`Funding agent ${agent.address} with ${formatEther(fundingAmount)} 0G`)
  try {
    const opWc = await operator.walletClient(network)
    const opAccount = opWc.account
    if (!opAccount) throw new Error('walletClient is missing default account')
    const fundGasPrice = await getGasPriceWithFloor(publicClient)
    const fundTx = await withSilencedConsole(() =>
      opWc.sendTransaction({
        to: agent.address as Address,
        value: fundingAmount,
        chain: operator.chain(network),
        account: opAccount,
        maxFeePerGas: fundGasPrice,
        maxPriorityFeePerGas: fundGasPrice,
      }),
    )
    await waitForReceiptResilient(publicClient, fundTx)
    await updateWizardState(paths.dir, draft => {
      draft.steps.agentFundedTx = fundTx
    })
    sFund.stop(`funded (tx ${fundTx})`)
  } catch (e) {
    sFund.stop(`fund failed: ${(e as Error).message}`)
    await operator.close?.()
    return
  }

  const sPersist = spinner()
  sPersist.start('Uploading keystore to 0G Storage + anchoring root hash on chain')
  let keystorePersisted = false
  try {
    const { rootHash, updateTx } = await withSilencedConsole(() =>
      uploadAndAnchorKeystore({
        network,
        agentPrivkey: agent.privkeyHex as Hex,
        tokenId: mintedTokenId!,
        contractAddress: contractAddress!,
        bytes: encryptedBytes,
      }),
    )
    await updateWizardState(paths.dir, draft => {
      draft.steps.keystorePersistedTx = updateTx
      draft.steps.keystoreRootHash = rootHash
    })
    keystorePersisted = true
    sPersist.stop(`keystore anchored (root ${rootHash.slice(0, 12)}…)`)
  } catch (e) {
    sPersist.stop(`keystore upload/anchor failed: ${(e as Error).message.slice(0, 120)}`)
  }

  if (!keystorePersisted) {
    note(
      [
        `iNFT #${mintedTokenId!.toString()} is minted, agent EOA is funded with ${formatEther(fundingAmount)} 0G,`,
        `and the encrypted keystore is on disk at ${paths.keystore}.`,
        '',
        'The 0G Storage upload + chain anchor failed, so this machine has',
        'a working agent but no on-chain recovery path yet. The funds at',
        `${agent.address} are NOT stranded; operator wallet ${operatorAddress}`,
        'can decrypt the local keystore and resume the agent.',
        '',
        'Re-run `anima init --resume` to retry the storage upload and anchor,',
        'or proceed with chat using the local keystore (sync will retry on',
        'every chat turn anyway).',
      ].join('\n'),
      'storage anchor failed (recoverable)',
    )
    cancel('Aborted before writing config (storage anchor pending).')
    await operator.close?.()
    return
  }

  // v0.23.1: cache the operator scope keys to `.operator-session` so:
  //   - First `anima` chat does NOT re-prompt Touch ID (`gateway-start` will
  //     find both keystore + profile scopes already cached and skip
  //     re-derivation).
  //   - First sync after init can encrypt + anchor the PROFILE slot
  //     transparently — operator never needs to run `anima profile init`.
  // requiredScopesForAgent now returns ['keystore', 'anima-profile-v1']
  // because seedStarterMemoryFiles just wrote user/profile.md.
  try {
    const sess = buildOperatorSession({ agent: agent.address as Address, keys: operatorKeys })
    writeOperatorSession(finalAgentId, sess)
  } catch (e) {
    console.warn(`operator-session write skipped: ${(e as Error).message.slice(0, 160)}`)
  }

  if (!skipLedger) {
    const sLedger = spinner()
    sLedger.start(`Opening 0G Compute ledger with ${ledgerSize} 0G`)
    try {
      const status = await withSilencedConsole(() =>
        openComputeLedger({
          network,
          privkeyHex: agent.privkeyHex as Hex,
          initialBalance: ledgerSize,
          providerAddress: modelPick?.provider,
        }),
      )
      await updateWizardState(paths.dir, draft => {
        draft.steps.ledgerOpenedTx = true
      })
      sLedger.stop(
        status.alreadyExisted
          ? `ledger topped up: ${formatEther(status.totalBalanceAfter)} 0G`
          : `ledger opened: ${formatEther(status.totalBalanceAfter)} 0G`,
      )
    } catch (e) {
      sLedger.stop(`ledger open failed: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  let registeredSubname: string | null = null
  if (requestedSubname && mintedTokenId !== null && contractAddress) {
    const sSub = spinner()
    sSub.start(`Registering ${requestedSubname}.anima.0g on mainnet`)
    try {
      registeredSubname = await withSilencedConsole(async () => {
        const registrar = new AnimaRegistrarClient({ privkeyHex: agent.privkeyHex as Hex })
        const sann = new SannClient({ privkeyHex: agent.privkeyHex as Hex })
        if (await registrar.isLabelTaken(requestedSubname)) return null
        const claimTx = await registrar.claim(requestedSubname, agent.address as Address)
        await registrar.waitForReceipt(claimTx)
        await updateWizardState(paths.dir, draft => {
          draft.steps.subnameClaimedTx = claimTx
        })
        const node = subnameNode(requestedSubname)
        const addrTx = await sann.setText(node, 'address', agent.address)
        await sann.waitForReceipt(addrTx)
        const inftTx = await sann.setText(
          node,
          'agent:inft',
          `eip155:${NETWORK_CHAIN_ID[network]}:${contractAddress}:${mintedTokenId.toString()}`,
        )
        await sann.waitForReceipt(inftTx)
        // Publish the agent's secp256k1 uncompressed pubkey so other animas
        // can ECIES-encrypt to this agent for A2A messaging (Phase 7).
        const pubkeyTx = await sann.setText(
          node,
          'pubkey',
          derivePubkeyHex(agent.privkeyHex as Hex),
        )
        await sann.waitForReceipt(pubkeyTx)
        await updateWizardState(paths.dir, draft => {
          draft.steps.textRecordsSetTx = pubkeyTx
        })
        sSub.stop(
          `${requestedSubname}.anima.0g registered → ${explorerTxUrl('0g-mainnet', claimTx)}`,
        )
        return requestedSubname
      })
      if (registeredSubname === null) {
        sSub.stop(`skipping: ${requestedSubname}.anima.0g was claimed mid-flow`)
      }
    } catch (e) {
      sSub.stop(`subname registration failed: ${(e as Error).message.slice(0, 120)}`)
    }
  }

  // v0.24.17: seed canonical memory starter files AFTER the SANN claim resolves
  // so identity.md + persona.md reflect the VERIFIED subname, not the operator's
  // intent. If the claim races or reverts, registeredSubname stays null and the
  // seed falls back to the generic "I am anima" template. Prior to v0.24.17 the
  // seed ran before the claim with `requestedSubname`, so a failed claim left
  // the agent confidently anchoring "I am chou" on slots 1+2 during the first
  // chat turn even though chain disagreed.
  await seedStarterMemoryFiles({
    paths,
    network,
    contractAddress: contractAddress!,
    tokenId: mintedTokenId!,
    agentAddress: agent.address as Address,
    operatorAddress,
    brainProvider: modelPick?.provider ?? null,
    brainModel: modelPick?.model ?? null,
    subname: registeredSubname,
  })

  // v0.24.4: Phase E (Telegram bot setup) MUST run before Phase 11 (sandbox
  // provision) so the sandbox handoff envelope can ship `telegram-secrets`
  // and the listener boots active. Previously Phase E ran AFTER provision and
  // the sandbox booted with `listeners.telegram: disabled`, forcing the
  // operator to `anima upgrade --in-place` post-init to re-ship secrets.
  let telegramConfigured: { botUsername: string; mode: string } | null = null
  if (mintedTokenId !== null && contractAddress) {
    const tgChoice = await confirm({
      message: 'Configure a Telegram bot for this agent now? (recommended)',
      initialValue: true,
    })
    if (!isCancel(tgChoice) && tgChoice === true) {
      try {
        const { runTelegramStep } = await import('./init/telegram-step')
        const tgResult = await runTelegramStep({
          signer: operator,
          agentId: finalAgentId,
          agentAddress: agent.address as Address,
          configPath,
          // Synthetic partial cfg — caller writes the final cfg below. Pass
          // skipConfigWrite=true so telegram-step doesn't touch disk.
          config: { plugins: [], subname: registeredSubname } as never,
          network,
          skipConfigWrite: true,
        })
        if (tgResult.configured && tgResult.botUsername && tgResult.modeUsed) {
          telegramConfigured = {
            botUsername: tgResult.botUsername,
            mode: tgResult.modeUsed,
          }
          // v0.24.3: append TELEGRAM key to `.operator-session` so the gateway
          // daemon auto-spawns on first chat without re-prompting Touch ID.
          if (tgResult.telegramScopeKeyHex) {
            try {
              const sess = buildOperatorSession({
                agent: agent.address as Address,
                keys: {
                  ...operatorKeys,
                  [OPERATOR_BLOB_SCOPES.TELEGRAM]: tgResult.telegramScopeKeyHex,
                },
              })
              writeOperatorSession(finalAgentId, sess)
            } catch (e) {
              note(
                `operator-session rewrite skipped: ${(e as Error).message.slice(0, 160)}\nRun \`anima telegram setup\` later to re-derive the TG scope key.`,
                'telegram (non-fatal)',
              )
            }
          }
        }
      } catch (e) {
        note(
          `Telegram step failed: ${(e as Error).message.slice(0, 200)}\nIdentity + iNFT + subname are safe. Re-run \`anima telegram setup\` later.`,
          'non-fatal',
        )
      }
    }
  }

  // Load TG handoff secrets into memory for the sandbox envelope. Skipped if
  // TG wasn't configured this run. The shape is exactly what the harness
  // expects inside the secondary ECIES envelope (botToken + allowedUserIds +
  // optional pairingApproved). Errors are non-fatal: TG is opt-in.
  let telegramHandoff: Awaited<ReturnType<typeof loadTelegramHandoffSecrets>> = undefined
  if (telegramConfigured && mintedTokenId !== null && contractAddress) {
    telegramHandoff = await loadTelegramHandoffSecrets({
      signer: operator,
      agentAddress: agent.address as Address,
      contractAddress,
      tokenId: mintedTokenId,
      onNotice: msg => note(msg, 'telegram handoff (non-fatal)'),
    })
  }

  // Phase 11: deploy harness into 0G Sandbox if user picked sandbox target.
  // Runs AFTER Phase E so handoff envelope can ship TG secrets to the
  // container. Sandbox boots with `listeners.telegram: active` first try.
  let sandboxResult: SandboxProvisionResult | null = null
  if (deployTarget === 'sandbox' && mintedTokenId !== null && contractAddress && modelPick) {
    const sBox = spinner()
    sBox.start('Deploying harness into 0G Sandbox (Galileo testnet)')
    const boxCtl = new BootstrapProgressController({
      spinner: sBox,
      cliVersion: await resolveCliVersion(),
      startedMsg: 'sandbox started, running bootstrap',
    })
    try {
      sandboxResult = await runSandboxProvision({
        operator,
        agentPrivkey: agent.privkeyHex as Hex,
        agentAddress: agent.address as Address,
        iNFTRef: { contract: contractAddress, tokenId: mintedTokenId },
        brain: { provider: modelPick.provider as Address, model: modelPick.model ?? '' },
        iNFTNetwork: network,
        name: requestedSubname || 'anima',
        ref: process.env.ANIMA_BOOTSTRAP_REF ?? 'main',
        subname: registeredSubname,
        profileScopeKeyHex,
        telegramSecrets: telegramHandoff,
        onProgress: boxCtl.onProgress,
        onStageEvent: boxCtl.onStageEvent,
        onTick: boxCtl.onTick,
      })
      await updateWizardState(paths.dir, draft => {
        draft.steps.sandboxId = sandboxResult!.sandboxId
        draft.steps.sandboxEndpoint = sandboxResult!.endpoint
      })
      boxCtl.finalize(`sandbox ${sandboxResult.sandboxId} ready @ ${sandboxResult.endpoint}`, msg =>
        log.step(msg),
      )

      // Publish agent:endpoint text record on the subname so the chat client
      // can discover where to talk. Skipped if subname registration failed.
      if (registeredSubname) {
        const sEp = spinner()
        sEp.start(`Publishing agent:endpoint on ${registeredSubname}.anima.0g`)
        try {
          await withSilencedConsole(async () => {
            const sann = new SannClient({ privkeyHex: agent.privkeyHex as Hex })
            const tx = await sann.setText(
              subnameNode(registeredSubname!),
              'agent:endpoint',
              sandboxResult!.endpoint,
            )
            await sann.waitForReceipt(tx)
          })
          sEp.stop('agent:endpoint published')
        } catch (e) {
          sEp.stop(`agent:endpoint publish failed: ${(e as Error).message.slice(0, 120)}`)
        }
      }
    } catch (e) {
      boxCtl.fail(`sandbox deploy failed: ${(e as Error).message.slice(0, 200)}`, msg =>
        log.error(msg),
      )
      note(
        [
          'iNFT minted, agent funded, keystore on 0G Storage, recoverable.',
          'Re-run `anima deploy` after fixing the sandbox-side issue.',
          `Likely cause: insufficient testnet 0G at ${operatorAddress}, or provider 504/upstream timeout.`,
        ].join('\n'),
        'sandbox-deploy aborted (recoverable)',
      )
    }
  } else if (deployTarget === 'sandbox') {
    note(
      'sandbox target selected but iNFT mint or model pick was missing; skipping handoff.',
      'sandbox deploy skipped',
    )
  }

  // ─── Write final config ─────────────────────────────────────────────────

  const cfg = defineConfig({
    identity: {
      iNFT:
        mintedTokenId !== null && contractAddress
          ? {
              contract: contractAddress,
              tokenId: mintedTokenId.toString(),
              network,
            }
          : null,
      operator: operatorAddress,
      agent: agent.address,
    },
    network,
    storage: { network },
    brain: {
      provider: modelPick?.provider ?? null,
      model: modelPick?.model ?? null,
    },
    plugins: telegramConfigured
      ? ['onchain', 'comms', 'system', 'telegram']
      : ['onchain', 'comms', 'system'],
    tools: {},
    imports: { claudeCode: true },
    operator: operatorHint,
    deployTarget: sandboxResult ? 'sandbox' : 'local',
    sandbox: sandboxResult
      ? {
          id: sandboxResult.sandboxId,
          endpoint: sandboxResult.endpoint,
          providerAddress: sandboxResult.providerAddress,
          snapshotName: sandboxResult.snapshotName,
        }
      : undefined,
  })
  await writeConfigTs(configPath, cfg, {
    header: '// Regenerated by `anima init`. Edit freely; type-safe.',
    subname: registeredSubname,
  })

  await operator.close?.()

  // ─── Phase D: summary ───────────────────────────────────────────────────

  const lines = [
    '',
    `  agent id   ${finalAgentId}`,
    `  agent EOA  ${agent.address}`,
    `  operator   ${operatorAddress}  (source: ${operatorHint.source})`,
    `  network    ${network} (${NETWORK_RPC[network]})`,
    `  chain id   ${NETWORK_CHAIN_ID[network]}`,
    `  config     ${configPath}`,
    `  keystore   on 0G Storage (cached at ${paths.keystore})`,
  ]
  if (mintedTokenId !== null && contractAddress) {
    lines.push(`  iNFT       #${mintedTokenId.toString()} at ${contractAddress}`)
    lines.push(`             ${explorerTokenUrl(network, contractAddress, mintedTokenId)}`)
  }
  if (registeredSubname) lines.push(`  subname    ${registeredSubname}.anima.0g (mainnet)`)
  if (modelPick) lines.push(`  brain      ${modelPick.model ?? '?'} (${modelPick.provider})`)
  if (!skipLedger) lines.push(`  ledger     ${ledgerSize} 0G`)
  if (telegramConfigured) {
    lines.push(`  bot        @${telegramConfigured.botUsername} (mode: ${telegramConfigured.mode})`)
  }
  const nextSteps = telegramConfigured
    ? 'Next: `anima` to chat · DM the bot on Telegram · `anima status` for health'
    : 'Next: `anima` to chat · `anima telegram setup` for the bot · `anima topup` to add funds'
  lines.push('', nextSteps)
  outro(lines.join('\n'))
}

interface SeedStarterOpts {
  paths: ReturnType<typeof agentPaths.agent>
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  agentAddress: Address
  operatorAddress: Address
  brainProvider: string | null
  brainModel: string | null
  /**
   * Operator-chosen SANN label (e.g. "chou" for `chou.anima.0g`). Threaded
   * into identity + persona so the agent introduces itself by name on the
   * very first turn instead of the generic "I am Anima" template.
   */
  subname: string | null
}

/**
 * Seed `MEMORY.md`, `/agent/identity.md`, `/agent/persona.md`, and
 * `/user/profile.md` immediately after mint so the per-turn sync manager
 * has real content for the identity / persona / memory-index slots on the
 * first chat turn. Without this, those slots stay bootstrap-placeholder
 * forever (gap discovered during the Phase 6.7 stress test).
 */
async function seedStarterMemoryFiles(opts: SeedStarterOpts): Promise<void> {
  const memDir = opts.paths.memoryDir
  const agentMem = `${memDir}/agent`
  const userMem = `${memDir}/user`
  await mkdir(agentMem, { recursive: true })
  await mkdir(userMem, { recursive: true })

  const now = new Date().toISOString().slice(0, 10)
  const displayName = opts.subname ?? 'anima'
  const fullName = opts.subname ? `${opts.subname}.anima.0g` : null
  const identityTitle = opts.subname
    ? `# ${opts.subname} identity (anima harness)`
    : '# Anima identity'
  const subnameLine = fullName ? `- Subname: ${fullName}\n` : ''
  const personaIntro = fullName
    ? `I am ${displayName} (${fullName}), a sovereign agent running on the anima harness on 0G.`
    : 'I am anima, a sovereign agent harness on 0G.'
  const identity = `---\nname: identity\ndescription: Auto-written agent identity facts.\ntype: agent-identity\n---\n${identityTitle}\n\n- Name: ${displayName}\n${subnameLine}- iNFT: #${opts.tokenId.toString()} at ${opts.contractAddress} (${opts.network})\n- Agent EOA: ${opts.agentAddress}\n- Operator: ${opts.operatorAddress}\n- Minted: ${now}\n${opts.brainProvider ? `- Brain provider: ${opts.brainProvider}\n` : ''}${opts.brainModel ? `- Brain model: ${opts.brainModel}\n` : ''}`
  const persona = `---\nname: persona\ndescription: Voice + behavior style.\ntype: agent-persona\n---\n# Persona\n\n${personaIntro} I anchor my state on chain every turn, decrypt my keystore via my operator wallet at session start, and use 0G Compute (TEE-attested) for reasoning. I am direct, concise, and factual. When asked who I am, I introduce myself as ${displayName}.\n`
  const profile =
    '---\nname: profile\ndescription: User profile (operator-scoped, never anchored on chain).\ntype: user\n---\n# User profile\n\n(empty, fills as we chat)\n'

  await writeFile(join(agentMem, 'identity.md'), identity, 'utf8')
  await writeFile(join(agentMem, 'persona.md'), persona, 'utf8')
  await writeFile(join(userMem, 'profile.md'), profile, 'utf8')

  // Seed an empty MEMORY.md so per-turn sync has something to anchor and the
  // brain's first turn sees a parseable index.
  await writeFile(opts.paths.memoryIndex, '# Anima Memory Index\n\n', 'utf8')
}
