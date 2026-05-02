import { cancel, confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts'
import {
  type AnimaNetwork,
  closeLedger,
  getLedgerDetail,
  refundFromLedger,
  retrieveLedgerFunds,
} from '@s0nderlabs/anima-core'
import { type Address, type Hex, formatEther, parseEther } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { withSilencedConsole } from '../util/silence-console'
import { unlockAgentSigner } from './_unlock'

export type LedgerSubcommand = 'balance' | 'refund' | 'retrieve' | 'close'

export interface LedgerOpts {
  sub: LedgerSubcommand
  /** For `refund`: amount in 0G to withdraw. Omit + `all=true` = withdraw full main balance. */
  amount?: number
  /** For `refund`: refund the entire main ledger balance. */
  all?: boolean
  /** For `close`: skip the destructive confirmation prompt. */
  yes?: boolean
}

export async function runLedger(opts: LedgerOpts): Promise<void> {
  intro(`anima ledger ${opts.sub}`)

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

  const network = config.network
  const agentAddress = config.identity.agent as Address

  if (opts.sub === 'balance') {
    const unlocked = await unlockAgentSigner(config)
    if (!unlocked) return
    try {
      await printBalance(network, unlocked.agentPrivkey, agentAddress)
      outro('balance shown')
    } finally {
      await unlocked.close()
    }
    return
  }

  if (opts.sub === 'retrieve') {
    const unlocked = await unlockAgentSigner(config)
    if (!unlocked) return
    const s = spinner()
    s.start('Retrieving funds from inference provider sub-accounts')
    try {
      await withSilencedConsole(() =>
        retrieveLedgerFunds({ network, privkeyHex: unlocked.agentPrivkey }),
      )
      s.stop('retrieve submitted')
      log.info(
        'Provider sub-accounts now have a pending refund. Some balance returns immediately; the rest unlocks after the contract lock window. Re-run `anima ledger retrieve` after the window to pull what was queued.',
      )
      await printBalance(network, unlocked.agentPrivkey, agentAddress)
      outro('retrieve done')
    } catch (e) {
      s.stop(`retrieve failed: ${(e as Error).message.slice(0, 160)}`)
    } finally {
      await unlocked.close()
    }
    return
  }

  if (opts.sub === 'refund') {
    const unlocked = await unlockAgentSigner(config)
    if (!unlocked) return
    try {
      const detail = await withSilencedConsole(() =>
        getLedgerDetail({ network, privkeyHex: unlocked.agentPrivkey }),
      )
      if (!detail) {
        log.warn('No ledger exists for this agent.')
        outro('nothing to refund')
        return
      }

      let amount = opts.amount
      if (opts.all || amount === undefined) {
        amount = Number(formatEther(detail.availableBalance))
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        log.warn(
          `Available balance is ${formatEther(detail.availableBalance)} 0G; nothing to refund.`,
        )
        outro('nothing to refund')
        return
      }
      if (parseEther(amount.toString()) > detail.availableBalance) {
        log.warn(
          `Requested ${amount} 0G but only ${formatEther(detail.availableBalance)} 0G is available in the main ledger. Run \`anima ledger retrieve\` first if funds are still in provider sub-accounts.`,
        )
        outro('refund skipped')
        return
      }

      const s = spinner()
      s.start(`Refunding ${amount} 0G from main ledger to ${agentAddress}`)
      await withSilencedConsole(() =>
        refundFromLedger({ network, privkeyHex: unlocked.agentPrivkey, amount: amount as number }),
      )
      s.stop('refund submitted')
      await printBalance(network, unlocked.agentPrivkey, agentAddress)
      outro(`refunded ${amount} 0G to agent EOA`)
    } catch (e) {
      log.error(`refund failed: ${(e as Error).message.slice(0, 160)}`)
    } finally {
      await unlocked.close()
    }
    return
  }

  // close
  const unlocked = await unlockAgentSigner(config)
  if (!unlocked) return
  try {
    if (!opts.yes) {
      const ok = (await confirm({
        message:
          'Close the ledger entirely? Funds in provider sub-accounts must be retrieved first.',
        initialValue: false,
      })) as boolean | symbol
      if (isCancel(ok) || !ok) {
        cancel('Aborted.')
        return
      }
    }
    const s = spinner()
    s.start('Deleting ledger')
    await withSilencedConsole(() => closeLedger({ network, privkeyHex: unlocked.agentPrivkey }))
    s.stop('ledger closed')
    outro('ledger removed; remaining main balance refunded to agent EOA')
  } catch (e) {
    log.error(`close failed: ${(e as Error).message.slice(0, 160)}`)
  } finally {
    await unlocked.close()
  }
}

async function printBalance(
  network: AnimaNetwork,
  privkeyHex: Hex,
  agentAddress: Address,
): Promise<void> {
  const detail = await withSilencedConsole(() => getLedgerDetail({ network, privkeyHex }))
  if (!detail) {
    log.info('No ledger exists for this agent yet.')
    return
  }
  log.info(
    [
      `agent      ${agentAddress}`,
      `available  ${formatEther(detail.availableBalance)} 0G`,
      `total      ${formatEther(detail.totalBalance)} 0G`,
      `providers  ${detail.inferenceProviders.length}`,
    ].join('\n'),
  )
  for (const p of detail.inferenceProviders) {
    log.info(
      `· ${p.provider}: balance=${formatEther(p.balance)} 0G, pendingRefund=${formatEther(p.pendingRefund)} 0G`,
    )
  }
}
