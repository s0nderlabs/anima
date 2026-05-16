import { cancel, intro, isCancel, outro, password, select, spinner } from '@clack/prompts'
import {
  SANDBOX_BURN_RATE_OG_PER_HOUR,
  SANDBOX_PROVIDER_GALILEO,
  SandboxSettlementClient,
  VISION_PROVIDER_DEFAULTS,
  agentPaths,
  depositToLedger,
  explorerTxUrl,
  fetchAndDecryptKeystore,
  getGasPriceWithFloor,
  getLedgerBalance,
  iNFTAgentId,
  transferFundToProvider,
  waitForReceiptResilient,
} from '@s0nderlabs/anima-core'
import { type Address, formatEther, getAddress, parseEther } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { withSilencedConsole } from '../util/silence-console'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export interface TopupOpts {
  /** Top up the agent EOA from operator wallet, amount in 0G. */
  agent?: number
  /** Top up the compute ledger from agent EOA, amount in 0G. */
  compute?: number
  /**
   * v0.21.5: top up the Galileo SandboxBilling deposit from operator wallet, amount in 0G.
   * Was: `provider` in v0.17.1+; renamed to disambiguate from "compute provider".
   */
  sandbox?: number
  /**
   * @deprecated Use `sandbox` instead. v0.17.1 named this `provider` (matching
   * the SandboxBilling smart-contract field name) which collided with "compute
   * provider". Kept as an alias for backwards compat with existing runbooks;
   * will be removed in a future release.
   */
  provider?: number
  /**
   * Transfer N 0G from the main ledger into the vision provider sub-account.
   * Without this, `vision.analyze` + `browser.vision` fail with "Sub-account
   * not found" on fresh agents (init wizard only seeds the inference
   * provider). Mainnet-only — no vision provider exists on testnet.
   */
  vision?: number
}

export async function runTopup(opts: TopupOpts): Promise<void> {
  intro('anima topup')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No anima.config.ts found. Run `anima init` first.')
    return
  }
  const { config } = loaded
  if (!config.identity.iNFT || !config.identity.agent) {
    cancel('Config has no iNFT or agent. Run `anima init` first.')
    return
  }

  const agentAddress = config.identity.agent as Address
  const network = config.network
  const finalAgentId = iNFTAgentId({
    contractAddress: config.identity.iNFT.contract as Address,
    tokenId: BigInt(config.identity.iNFT.tokenId),
  })
  const paths = agentPaths.agent(finalAgentId)

  // 'sandbox' is the canonical mode discriminant (was 'provider' in v0.17.1+).
  // `opts.provider` is accepted as a backwards-compat alias.
  let mode: 'agent' | 'compute' | 'sandbox' | 'vision' | null = null
  let amount = 0
  if (opts.agent !== undefined) {
    mode = 'agent'
    amount = opts.agent
  } else if (opts.compute !== undefined) {
    mode = 'compute'
    amount = opts.compute
  } else if (opts.sandbox !== undefined) {
    mode = 'sandbox'
    amount = opts.sandbox
  } else if (opts.provider !== undefined) {
    mode = 'sandbox'
    amount = opts.provider
  } else if (opts.vision !== undefined) {
    mode = 'vision'
    amount = opts.vision
  }

  if (!mode) {
    const choice = (await select({
      message: 'What do you want to top up?',
      options: [
        {
          value: 'agent' as const,
          label: 'Agent wallet (infra gas)',
          hint: 'operator sends 0G to agent EOA',
        },
        {
          value: 'compute' as const,
          label: 'Compute ledger (inference credits)',
          hint: 'agent deposits 0G into 0G Compute (mainnet)',
        },
        {
          value: 'vision' as const,
          label: 'Vision provider sub-account (vision.analyze + browser.vision)',
          hint: 'transfer from main ledger into vision provider envelope (mainnet)',
        },
        {
          value: 'sandbox' as const,
          label: 'Sandbox billing deposit (Galileo testnet runtime fees)',
          hint: 'operator deposits 0G into SandboxBilling for harness burn',
        },
      ],
    })) as 'agent' | 'compute' | 'sandbox' | 'vision' | symbol
    if (isCancel(choice)) {
      cancel('Aborted.')
      return
    }
    mode = choice

    const amtRaw = (await password({
      message: `Amount in 0G to move to ${mode}`,
      validate: v => {
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0) return 'Positive number required.'
        return undefined
      },
    })) as string | symbol
    if (isCancel(amtRaw)) {
      cancel('Aborted.')
      return
    }
    amount = Number(amtRaw)
  }

  if (mode === 'sandbox') {
    const operator = await loadOrPickOperatorSigner({ network, hint: config.operator })
    if (!operator) return
    const operatorAccount = await operator.account()
    const galileoPub = await operator.publicClient('0g-testnet')
    const galileoWallet = await operator.walletClient('0g-testnet')
    const settle = new SandboxSettlementClient({
      publicClient: galileoPub,
      walletClient: galileoWallet,
    })
    const wei = parseEther(String(amount))

    const sBefore = spinner()
    sBefore.start('Reading current Galileo deposit')
    let before = 0n
    try {
      before = await settle.getBalance(operatorAccount.address, SANDBOX_PROVIDER_GALILEO)
      sBefore.stop(
        `current deposit ${formatEther(before)} 0G (~${(Number(before) / 1e18 / SANDBOX_BURN_RATE_OG_PER_HOUR).toFixed(1)}h runway)`,
      )
    } catch (e) {
      sBefore.stop(`balance read failed: ${(e as Error).message.slice(0, 120)}`)
    }

    const sDep = spinner()
    sDep.start(`Depositing ${amount} 0G to Galileo provider`)
    try {
      const tx = await settle.deposit({
        recipient: operatorAccount.address,
        provider: SANDBOX_PROVIDER_GALILEO,
        amountWei: wei,
      })
      await waitForReceiptResilient(galileoPub, tx, { tries: 60, delayMs: 2000 })
      const after = await settle.getBalance(operatorAccount.address, SANDBOX_PROVIDER_GALILEO)
      sDep.stop(
        `deposit confirmed → ${explorerTxUrl('0g-testnet', tx)} (new balance ${formatEther(after)} 0G ≈ ${(Number(after) / 1e18 / SANDBOX_BURN_RATE_OG_PER_HOUR).toFixed(1)}h)`,
      )
      outro(`Galileo deposit topped up by ${amount} 0G`)
    } catch (e) {
      sDep.stop(`deposit failed: ${(e as Error).message.slice(0, 120)}`)
    } finally {
      await operator.close?.()
    }
    return
  }

  if (mode === 'agent') {
    const operator = await loadOrPickOperatorSigner({ network, hint: config.operator })
    if (!operator) return

    const s = spinner()
    s.start(`Sending ${amount} 0G from operator to agent ${agentAddress}`)
    try {
      const opWc = await operator.walletClient(network)
      const opAccount = opWc.account
      if (!opAccount) throw new Error('walletClient is missing default account')
      const pub = await operator.publicClient(network)
      const fundGasPrice = await getGasPriceWithFloor(pub)
      const tx = await withSilencedConsole(() =>
        opWc.sendTransaction({
          to: agentAddress,
          value: parseEther(String(amount)),
          chain: operator.chain(network),
          account: opAccount,
          maxFeePerGas: fundGasPrice,
          maxPriorityFeePerGas: fundGasPrice,
        }),
      )
      await waitForReceiptResilient(pub, tx)
      s.stop(`funded → ${explorerTxUrl(network, tx)}`)
      outro(`agent ${agentAddress} balance refreshed`)
    } catch (e) {
      s.stop(`fund failed: ${(e as Error).message.slice(0, 120)}`)
    } finally {
      await operator.close?.()
    }
    return
  }

  // mode === 'compute' or 'vision' — both need the agent's privkey since
  // they're agent-signed broker calls (depositFund vs transferFund).
  if (mode === 'vision' && network !== '0g-mainnet') {
    cancel('Vision provider is mainnet-only; no testnet provider exists yet.')
    return
  }
  const operator = await loadOrPickOperatorSigner({ network, hint: config.operator })
  if (!operator) return

  const inftContract = config.identity.iNFT.contract as Address
  const inftTokenId = BigInt(config.identity.iNFT.tokenId)

  const sUnlock = spinner()
  sUnlock.start('Fetching encrypted keystore + decrypting via operator wallet')
  let agentPrivkey: `0x${string}`
  try {
    const decrypted = await withSilencedConsole(() =>
      fetchAndDecryptKeystore({
        network,
        contractAddress: inftContract,
        tokenId: inftTokenId,
        signer: operator,
        agentAddress,
        cachePath: paths.keystore,
      }),
    )
    agentPrivkey = decrypted.privkeyHex
    sUnlock.stop(`unlocked (keystore source: ${decrypted.source})`)
  } catch (e) {
    sUnlock.stop(`unlock failed: ${(e as Error).message.slice(0, 160)}`)
    await operator.close?.()
    return
  }

  const sBal = spinner()
  sBal.start('Reading current ledger balance')
  try {
    const bal = await withSilencedConsole(() =>
      getLedgerBalance({ network, privkeyHex: agentPrivkey }),
    )
    sBal.stop(
      bal
        ? `current ledger ${formatEther(bal.totalBalance)} 0G total / ${formatEther(bal.availableBalance)} 0G available`
        : 'no ledger yet — depositing will open one',
    )
  } catch (e) {
    sBal.stop(`balance read failed: ${(e as Error).message.slice(0, 120)}`)
  }

  if (mode === 'vision') {
    const providerRaw = VISION_PROVIDER_DEFAULTS[network as '0g-mainnet']
    if (!providerRaw) {
      console.error(`Vision provider not configured for network ${network}`)
      await operator.close?.()
      return
    }
    const provider = getAddress(providerRaw)
    const sVis = spinner()
    sVis.start(`Transferring ${amount} 0G from main ledger to vision provider sub-account`)
    try {
      await withSilencedConsole(() =>
        transferFundToProvider({ network, privkeyHex: agentPrivkey, provider, amount }),
      )
      sVis.stop(`vision sub-account seeded (${provider.slice(0, 8)}...${provider.slice(-4)})`)
      outro(
        `vision provider has ${amount} 0G allocated. vision.analyze + browser.vision should work now.`,
      )
    } catch (e) {
      sVis.stop(`transfer failed: ${(e as Error).message.slice(0, 160)}`)
    } finally {
      await operator.close?.()
    }
    return
  }

  const sDep = spinner()
  sDep.start(`Depositing ${amount} 0G into compute ledger`)
  try {
    await withSilencedConsole(() => depositToLedger({ network, privkeyHex: agentPrivkey, amount }))
    sDep.stop('deposit complete')
    outro(`ledger topped up by ${amount} 0G`)
  } catch (e) {
    sDep.stop(`deposit failed: ${(e as Error).message.slice(0, 120)}`)
  } finally {
    await operator.close?.()
  }
}
