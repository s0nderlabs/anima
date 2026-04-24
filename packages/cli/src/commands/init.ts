import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from '@clack/prompts'
import {
  type AnimaNetwork,
  AnimaRegistrarClient,
  MIN_GAS_PRICE,
  NETWORK_CHAIN_ID,
  NETWORK_RPC,
  SannClient,
  agentPaths,
  defineConfig,
  explorerTokenUrl,
  explorerTxUrl,
  generateAgentWallet,
  iNFTAgentId,
  isLabelTaken,
  mainnetReadOnlyClient,
  mintAgent,
  openComputeLedger,
  persistKeystoreToStorage,
  placeholderAgentId,
  saveKeystore,
  subnameNode,
  waitForReceiptResilient,
} from '@s0nderlabs/anima-core'
import { type Address, type Hex, formatEther, parseEther } from 'viem'
import { writeConfigTs } from '../config/render'
import { estimateCosts, renderCostSummary } from './init/cost'
import { fundingGate } from './init/funding-gate'
import { pickBrainModel } from './init/model-picker'
import { pickOperatorSigner } from './init/operator-picker'
import { initialWizardState, updateWizardState, writeWizardState } from './init/wizard-state'

export async function runInit(opts?: { cwd?: string; resume?: boolean }): Promise<void> {
  const cwd = opts?.cwd ?? process.cwd()
  const configPath = join(cwd, 'anima.config.ts')

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
      if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(v))
        return 'Subnames: 3-32 chars, lowercase a-z, 0-9, hyphens (not leading/trailing).'
      return undefined
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
        hint: 'contract minimum — just trying it',
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

  const pass = await password({
    message: 'Choose a passphrase for the agent keystore (min 8 chars)',
    validate: v => (v && v.length >= 8 ? undefined : 'Min 8 chars required.'),
  })
  if (isCancel(pass)) {
    cancel('Aborted.')
    return
  }
  const passConfirm = await password({ message: 'Confirm passphrase' })
  if (isCancel(passConfirm)) {
    cancel('Aborted.')
    return
  }
  if (pass !== passConfirm) {
    cancel('Passphrases do not match.')
    return
  }

  // ─── Phase B: wallet gate ────────────────────────────────────────────────

  const operator = await pickOperatorSigner({ network })
  if (!operator) return

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
      `Operator balance ${formatEther(operatorBalance)} 0G — need ${formatEther(need)} 0G more.`,
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
  await saveKeystore(provisional.keystore, agent.privkeyHex, pass)

  await writeWizardState(provisional.dir, {
    ...initialWizardState(agent.address, network),
    steps: {
      ...initialWizardState(agent.address, network).steps,
      keystoreSaved: true,
    },
  })

  let mintedTokenId: bigint | null = null
  let contractAddress: Address | null = null

  const sMint = spinner()
  sMint.start(`Minting iNFT on ${network}`)
  try {
    const { result, contractAddress: c } = await mintAgent({
      network,
      operator,
      agentAddress: agent.address as Address,
      keystorePath: provisional.keystore,
    })
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

  const sFund = spinner()
  const fundingAmount = parseEther('0.1') + parseEther(String(ledgerSize))
  sFund.start(`Funding agent ${agent.address} with ${formatEther(fundingAmount)} 0G`)
  try {
    const opWc = await operator.walletClient(network)
    const fundTx = await opWc.sendTransaction({
      to: agent.address as Address,
      value: fundingAmount,
      chain: operator.chain(network),
      account: await operator.account(),
      maxFeePerGas: MIN_GAS_PRICE,
      maxPriorityFeePerGas: MIN_GAS_PRICE,
    })
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
  sPersist.start('Persisting encrypted keystore to 0G Storage')
  try {
    const { readFile } = await import('node:fs/promises')
    const keystoreBytes = new Uint8Array(await readFile(paths.keystore))
    const { rootHash, updateTx } = await persistKeystoreToStorage({
      network,
      agentPrivkey: agent.privkeyHex as Hex,
      tokenId: mintedTokenId!,
      contractAddress: contractAddress!,
      keystoreBytes,
    })
    await updateWizardState(paths.dir, draft => {
      draft.steps.keystorePersistedTx = updateTx
      draft.steps.keystoreRootHash = rootHash
    })
    sPersist.stop(`keystore anchored (root ${rootHash.slice(0, 12)}…)`)
  } catch (e) {
    sPersist.stop(`keystore persistence failed: ${(e as Error).message.slice(0, 120)}`)
    // Non-fatal — user can re-run later via topup-style command. Continue.
  }

  if (!skipLedger) {
    const sLedger = spinner()
    sLedger.start(`Opening 0G Compute ledger with ${ledgerSize} 0G`)
    try {
      const status = await openComputeLedger({
        network,
        privkeyHex: agent.privkeyHex as Hex,
        initialBalance: ledgerSize,
        providerAddress: modelPick?.provider,
      })
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
      const registrar = new AnimaRegistrarClient({ privkeyHex: agent.privkeyHex as Hex })
      const sann = new SannClient({ privkeyHex: agent.privkeyHex as Hex })
      if (await registrar.isLabelTaken(requestedSubname)) {
        sSub.stop(`skipping: ${requestedSubname}.anima.0g was claimed mid-flow`)
      } else {
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
        registeredSubname = requestedSubname
        sSub.stop(
          `${requestedSubname}.anima.0g registered → ${explorerTxUrl('0g-mainnet', claimTx)}`,
        )
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
    `  operator   ${operatorAddress}`,
    `  network    ${network} (${NETWORK_RPC[network]})`,
    `  chain id   ${NETWORK_CHAIN_ID[network]}`,
    `  keystore   ${paths.keystore}`,
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
