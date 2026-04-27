import { cancel, intro, isCancel, outro, password, select, spinner } from '@clack/prompts'
import {
  agentPaths,
  depositToLedger,
  explorerTxUrl,
  fetchAndDecryptKeystore,
  getGasPriceWithFloor,
  getLedgerBalance,
  iNFTAgentId,
  waitForReceiptResilient,
} from '@s0nderlabs/anima-core'
import { type Address, formatEther, parseEther } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { withSilencedConsole } from '../util/silence-console'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export interface TopupOpts {
  /** Top up the agent EOA from operator wallet, amount in 0G. */
  agent?: number
  /** Top up the compute ledger from agent EOA, amount in 0G. */
  compute?: number
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

  let mode: 'agent' | 'compute' | null = null
  let amount = 0
  if (opts.agent !== undefined) {
    mode = 'agent'
    amount = opts.agent
  } else if (opts.compute !== undefined) {
    mode = 'compute'
    amount = opts.compute
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
          hint: 'agent deposits 0G into 0G Compute',
        },
      ],
    })) as 'agent' | 'compute' | symbol
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

  // mode === 'compute' — needs the agent's privkey to deposit to its ledger.
  // Phase 6.6: fetch encrypted keystore, ask operator to sign typed data, decrypt.
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
