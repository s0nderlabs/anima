/**
 * `account.balance` — full position aggregator.
 *
 * Why this is separate from `account.info`: identity bundles want a small
 * payload; balance questions want every envelope expanded. EOA-only answers
 * under-count by ~10x because compute envelopes (locked in 0G provider
 * sub-accounts) are usually larger than the EOA itself.
 */

import {
  NETWORK_RPC,
  format0G,
  getLedgerDetailReadOnly,
  getSandboxBillingReserve,
} from '@s0nderlabs/anima-core'
import type { ToolDef } from '@s0nderlabs/anima-core'
import { http, type Address, createPublicClient } from 'viem'
import { z } from 'zod'
import type { OnchainRuntimeContext } from '../types'

const Schema = z.object({})
type Args = z.infer<typeof Schema>

interface BalanceResult {
  agentEoa: Address
  eoaMainnet: { wei: string; formatted: string }
  eoaTestnet: { wei: string; formatted: string }
  computeLedger: {
    totalWei: string
    availableWei: string
    lockedWei: string
    totalFormatted: string
    availableFormatted: string
    lockedFormatted: string
  } | null
  sandboxBillingReserve: {
    operatorAddress: Address
    wei: string
    formatted: string
  } | null
  positionSummary: {
    mainnetTotalFormatted: string
    testnetTotalFormatted: string
  }
}

export function makeAccountBalance(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'account.balance',
    description:
      'Full balance: EOA mainnet + EOA testnet + compute ledger total/available/locked + sandbox billing reserve. Read-only, no signer.',
    searchHint:
      'balance position funds compute ledger envelope sandbox billing reserve total — call this for "what\'s my balance" / "how much do we have" / "show full position". Use account.info for identity bundling.',
    schema: Schema,
    handler: async () => {
      try {
        // ctx.publicClient is bound to config.network; explicitly create per-chain
        // clients so an agent on testnet still gets distinct mainnet vs testnet reads.
        const mainnetClient =
          ctx.network === '0g-mainnet'
            ? ctx.publicClient
            : createPublicClient({ transport: http(NETWORK_RPC['0g-mainnet']) })
        const testnetClient =
          ctx.network === '0g-testnet'
            ? ctx.publicClient
            : createPublicClient({ transport: http(NETWORK_RPC['0g-testnet']) })

        const [eoaMainnetWei, eoaTestnetWei, ledger, sandboxReserve] = await Promise.all([
          mainnetClient.getBalance({ address: ctx.agentEoa }).catch(() => 0n),
          testnetClient.getBalance({ address: ctx.agentEoa }).catch(() => 0n),
          getLedgerDetailReadOnly({
            network: '0g-mainnet',
            agentAddress: ctx.agentEoa,
          }).catch(() => null),
          ctx.deployTarget === 'sandbox' && ctx.operatorAddress
            ? getSandboxBillingReserve({ recipient: ctx.operatorAddress })
            : Promise.resolve(null),
        ])

        const mainnetTotalWei = eoaMainnetWei + (ledger?.totalBalance ?? 0n)
        const testnetTotalWei = eoaTestnetWei + (sandboxReserve ?? 0n)

        const result: BalanceResult = {
          agentEoa: ctx.agentEoa,
          eoaMainnet: { wei: eoaMainnetWei.toString(), formatted: format0G(eoaMainnetWei) },
          eoaTestnet: { wei: eoaTestnetWei.toString(), formatted: format0G(eoaTestnetWei) },
          computeLedger: ledger
            ? {
                totalWei: ledger.totalBalance.toString(),
                availableWei: ledger.availableBalance.toString(),
                lockedWei: ledger.lockedBalance.toString(),
                totalFormatted: format0G(ledger.totalBalance),
                availableFormatted: format0G(ledger.availableBalance),
                lockedFormatted: format0G(ledger.lockedBalance),
              }
            : null,
          sandboxBillingReserve:
            sandboxReserve !== null && ctx.operatorAddress
              ? {
                  operatorAddress: ctx.operatorAddress,
                  wei: sandboxReserve.toString(),
                  formatted: format0G(sandboxReserve),
                }
              : null,
          positionSummary: {
            mainnetTotalFormatted: format0G(mainnetTotalWei),
            testnetTotalFormatted: format0G(testnetTotalWei),
          },
        }

        return { ok: true, data: result }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
