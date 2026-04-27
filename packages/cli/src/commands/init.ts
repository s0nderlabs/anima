import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cancel,
  confirm,
  intro,
  isCancel,
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
  SannClient,
  agentPaths,
  defineConfig,
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
  saveKeystoreLocally,
  subnameNode,
  uploadAndAnchorKeystore,
  validateSubnameLabel,
  waitForReceiptResilient,
} from '@s0nderlabs/anima-core'
import { type Address, type Hex, formatEther, parseEther } from 'viem'
import { writeConfigTs } from '../config/render'
import { withSilencedConsole } from '../util/silence-console'
import { estimateCosts, renderCostSummary } from './init/cost'
import { fundingGate } from './init/funding-gate'
import { pickBrainModel } from './init/model-picker'
import { pickOperatorSigner } from './init/operator-picker'
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

  // Save the agent keystore to disk BEFORE funding the agent EOA. Operator
  // signs once now to derive the AEAD key; the encrypted blob lives at
  // <agentDir>/keystore.json. Even if every subsequent step fails (storage
  // upload, chain anchor, subname), the operator can recover the agent
  // privkey from this file. See `feedback-init-must-save-keystore-before-
  // funding.md` for why this ordering is mandatory.
  const sLocal = spinner()
  sLocal.start('Encrypting agent keystore to operator wallet (local insurance)')
  let encryptedBytes: Uint8Array
  try {
    const saved = await saveKeystoreLocally({
      signer: operator,
      agentAddress: agent.address as Address,
      agentPrivkey: agent.privkeyHex as Hex,
      cachePath: paths.keystore,
    })
    encryptedBytes = saved.bytes
    await updateWizardState(paths.dir, draft => {
      draft.steps.keystoreSaved = true
    })
    sLocal.stop(`keystore saved locally at ${paths.keystore}`)
  } catch (e) {
    sLocal.stop(`local keystore save failed: ${(e as Error).message.slice(0, 120)}`)
    cancel('Aborted before funding (operator wallet could not derive AEAD key).')
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

  // Phase 6.7: seed canonical memory starter files so identity / persona /
  // profile slots can land on chain on the first chat turn. Without this the
  // sync manager has nothing to anchor for those slots and they stay
  // bootstrap-placeholder forever (gap discovered during stress test).
  await seedStarterMemoryFiles({
    paths,
    network,
    contractAddress: contractAddress!,
    tokenId: mintedTokenId!,
    agentAddress: agent.address as Address,
    operatorAddress,
    brainProvider: modelPick?.provider ?? null,
    brainModel: modelPick?.model ?? null,
  })

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
        await updateWizardState(paths.dir, draft => {
          draft.steps.textRecordsSetTx = inftTx
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
    plugins: ['onchain', 'comms', 'system'],
    tools: {},
    imports: { claudeCode: true },
    operator: operatorHint,
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
  lines.push('', 'Next: `anima` to chat · `anima status` for health · `anima topup` to add funds')
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
  const identity = `---\nname: identity\ndescription: Auto-written agent identity facts.\ntype: agent-identity\n---\n# Anima identity\n\n- iNFT: #${opts.tokenId.toString()} at ${opts.contractAddress} (${opts.network})\n- Agent EOA: ${opts.agentAddress}\n- Operator: ${opts.operatorAddress}\n- Minted: ${now}\n${opts.brainProvider ? `- Brain provider: ${opts.brainProvider}\n` : ''}${opts.brainModel ? `- Brain model: ${opts.brainModel}\n` : ''}`
  const persona =
    '---\nname: persona\ndescription: Voice + behavior style.\ntype: agent-persona\n---\n# Persona\n\nI am Anima, a sovereign agent runtime on 0G. I anchor my state on chain every turn, decrypt my keystore via my operator wallet at session start, and use 0G Compute (TEE-attested) for reasoning. I am direct, concise, and factual.\n'
  const profile =
    '---\nname: profile\ndescription: User profile (operator-scoped, never anchored on chain).\ntype: user\n---\n# User profile\n\n(empty, fills as we chat)\n'

  await writeFile(join(agentMem, 'identity.md'), identity, 'utf8')
  await writeFile(join(agentMem, 'persona.md'), persona, 'utf8')
  await writeFile(join(userMem, 'profile.md'), profile, 'utf8')

  // Seed an empty MEMORY.md so per-turn sync has something to anchor and the
  // brain's first turn sees a parseable index.
  await writeFile(opts.paths.memoryIndex, '# Anima Memory Index\n\n', 'utf8')
}
