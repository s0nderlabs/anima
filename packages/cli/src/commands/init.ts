import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
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
  KeychainOperatorSigner,
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
  mintAgent,
  placeholderAgentId,
  saveKeystore,
  subnameNode,
  waitForReceiptResilient,
} from '@s0nderlabs/anima-core'
import type { Hex } from 'viem'
import { formatEther, parseEther } from 'viem'
import { writeConfigTs } from '../config/render'

export async function runInit(opts?: { cwd?: string }): Promise<void> {
  const cwd = opts?.cwd ?? process.cwd()
  const configPath = join(cwd, 'anima.config.ts')

  intro('anima init')

  if (existsSync(configPath)) {
    const ok = await confirm({
      message: `${configPath} already exists. Overwrite?`,
      initialValue: false,
    })
    if (isCancel(ok) || !ok) {
      cancel('Aborted.')
      return
    }
  }

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

  const subname = await text({
    message: 'Subname under anima.0g (leave blank to pick later)',
    placeholder: 'e.g. alice',
    validate: v => {
      if (!v) return undefined
      if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(v))
        return 'Subnames: 3-32 chars, lowercase a-z, 0-9, hyphens (not leading/trailing).'
      return undefined
    },
  })
  if (isCancel(subname)) {
    cancel('Aborted.')
    return
  }

  const pass = await password({
    message: 'Choose a passphrase for the agent keystore (min 8 chars)',
    validate: v => (v && v.length >= 8 ? undefined : 'Min 8 chars required.'),
  })
  if (isCancel(pass)) {
    cancel('Aborted.')
    return
  }

  const passConfirm = await password({
    message: 'Confirm passphrase',
  })
  if (isCancel(passConfirm)) {
    cancel('Aborted.')
    return
  }
  if (pass !== passConfirm) {
    cancel('Passphrases do not match.')
    return
  }

  const s = spinner()
  s.start('Generating agent EOA')
  const { privkeyHex, address } = generateAgentWallet()
  const provisionalAgentId = placeholderAgentId(address)
  const provisional = agentPaths.agent(provisionalAgentId)
  await mkdir(provisional.dir, { recursive: true })
  await saveKeystore(provisional.keystore, privkeyHex, pass)
  s.stop(`Agent EOA ${address}`)

  // Load operator wallet (dev pattern: macOS keychain, see feedback-wallet-source-multi-option.md).
  const operator = new KeychainOperatorSigner()
  const operatorAddress = await operator.address()
  const operatorPublic = await operator.publicClient(network)
  const operatorBalance = await operatorPublic.getBalance({ address: operatorAddress })
  const operatorHasGas = operatorBalance > 0n

  let mintedTokenId: bigint | null = null
  let contractAddress: string | null = null
  let finalAgentId = provisionalAgentId
  let operatorOwnerAddress: string | null = null

  if (!operatorHasGas) {
    note(
      `Operator wallet ${operatorAddress} has 0 0G on ${network}. Fund it and re-run.`,
      'Skipping mint',
    )
  } else {
    const mintChoice = await confirm({
      message: `Mint iNFT (owner=${operatorAddress}) on ${network}? (operator balance: ${formatEther(operatorBalance)} 0G)`,
      initialValue: true,
    })
    if (isCancel(mintChoice)) {
      cancel('Aborted.')
      return
    }
    if (mintChoice) {
      const sMint = spinner()
      sMint.start(`Minting iNFT on ${network}`)
      try {
        const {
          result,
          contractAddress: c,
          operatorAddress: owner,
        } = await mintAgent({
          network,
          operator,
          agentAddress: address as `0x${string}`,
          keystorePath: provisional.keystore,
        })
        mintedTokenId = result.tokenId
        contractAddress = c
        operatorOwnerAddress = owner
        finalAgentId = iNFTAgentId({ contractAddress: c, tokenId: result.tokenId })
        sMint.stop(
          `iNFT #${result.tokenId.toString()} minted to ${owner} → ${explorerTxUrl(network, result.txHash)}`,
        )

        // Fund agent EOA from operator (subname claim + memory sync gas).
        const sFund = spinner()
        sFund.start(`Funding agent ${address} with 0.03 0G from operator`)
        const opWc = await operator.walletClient(network)
        const fundTx = await opWc.sendTransaction({
          to: address as `0x${string}`,
          value: parseEther('0.03'),
          chain: operator.chain(network),
          account: await operator.account(),
          maxFeePerGas: MIN_GAS_PRICE,
          maxPriorityFeePerGas: MIN_GAS_PRICE,
        })
        await waitForReceiptResilient(operatorPublic, fundTx)
        sFund.stop(`agent funded (tx ${fundTx})`)
      } catch (e) {
        sMint.stop(`mint failed: ${(e as Error).message}`)
      }
    }
  }

  // Move the agent state dir to the iNFT-derived id if we minted
  if (finalAgentId !== provisionalAgentId) {
    const { rename } = await import('node:fs/promises')
    const target = agentPaths.agent(finalAgentId)
    try {
      await rename(provisional.dir, target.dir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  const paths = agentPaths.agent(finalAgentId)

  let registeredSubname: string | null = null
  const requestedSubname = subname || null
  if (requestedSubname && mintedTokenId !== null && contractAddress) {
    registeredSubname = requestedSubname
    const sSub = spinner()
    sSub.start(`Registering ${registeredSubname}.anima.0g on mainnet`)
    try {
      const registrar = new AnimaRegistrarClient({ privkeyHex: privkeyHex as Hex })
      const sann = new SannClient({ privkeyHex: privkeyHex as Hex })
      if (await registrar.isLabelTaken(registeredSubname)) {
        sSub.stop(`skipping: ${registeredSubname}.anima.0g already claimed`)
        registeredSubname = null
      } else {
        const claimTx = await registrar.claim(registeredSubname, address as `0x${string}`)
        await registrar.waitForReceipt(claimTx)
        const node = subnameNode(registeredSubname)
        const addrTx = await sann.setText(node, 'address', address)
        await sann.waitForReceipt(addrTx)
        const inftTx = await sann.setText(
          node,
          'agent:inft',
          `eip155:${NETWORK_CHAIN_ID[network]}:${contractAddress}:${mintedTokenId.toString()}`,
        )
        await sann.waitForReceipt(inftTx)
        sSub.stop(
          `${registeredSubname}.anima.0g registered → ${explorerTxUrl('0g-mainnet', claimTx)}`,
        )
      }
    } catch (e) {
      sSub.stop(`subname registration failed: ${(e as Error).message}`)
      registeredSubname = null
    }
  }

  const s2 = spinner()
  s2.start('Writing anima.config.ts')
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
      operator: operatorOwnerAddress,
      agent: address,
    },
    network,
    storage: { network },
    brain: { provider: null, model: null },
    plugins: ['onchain', 'comms', 'system'],
    tools: {},
    imports: { claudeCode: true },
  })
  await writeConfigTs(configPath, cfg, {
    header: '// Regenerated by `anima init`. Edit freely; type-safe.',
    subname: registeredSubname,
  })
  s2.stop(`Wrote ${configPath}`)

  const lines = [
    '',
    `  agent id   ${finalAgentId}`,
    `  agent EOA  ${address}`,
    `  operator   ${operatorOwnerAddress ?? operatorAddress}${mintedTokenId === null ? ' (skipped)' : ''}`,
    `  network    ${network} (${NETWORK_RPC[network]})`,
    `  chain id   ${NETWORK_CHAIN_ID[network]}`,
    `  keystore   ${paths.keystore}`,
  ]
  if (mintedTokenId !== null && contractAddress) {
    lines.push(`  iNFT       #${mintedTokenId.toString()} at ${contractAddress}`)
    lines.push(`             ${explorerTokenUrl(network, contractAddress, mintedTokenId)}`)
  }
  if (registeredSubname) lines.push(`  subname    ${registeredSubname}.anima.0g (mainnet)`)
  lines.push('', 'Next: run `anima` to chat, or `anima sync` to push state to 0G Storage.')
  outro(lines.join('\n'))
}
