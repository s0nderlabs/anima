import { type Address, type Hex, formatEther } from 'viem'
import { getGasPriceWithFloor, makeViemClients } from '../chain'
import type { AnimaNetwork } from '../config'
import { waitForReceiptResilient } from '../identity/receipt'

/**
 * Sweep an agent EOA's native balance to a target address. Reserves enough
 * for the sweep tx itself (21000 gas at the live max-fee), so the resulting
 * balance is "as close to 0 as the gas reserve allows" without underpaying.
 *
 * Used by `anima drain` for fund recovery on a retiring agent. Does not
 * touch the compute ledger; that's `anima ledger refund`.
 */

export interface DrainAgentResult {
  txHash: Hex
  amountSent: bigint
  gasReserved: bigint
}

export const SWEEP_GAS_LIMIT = 21_000n

/**
 * Pure helper: given balance + gasPrice + optional override, return the value
 * to send, the gas reserve, and an error message if the balance can't cover
 * the sweep. Lifted out of drainAgentEOA so it can be unit-tested without a
 * live RPC.
 */
export function computeSweepAmount(opts: {
  balance: bigint
  gasPrice: bigint
  agentAddress: Address
  gasReserveOverride?: bigint
}): { value: bigint; gasReserve: bigint; error?: string } {
  const gasReserve = opts.gasReserveOverride ?? SWEEP_GAS_LIMIT * opts.gasPrice
  if (opts.balance <= gasReserve) {
    return {
      value: 0n,
      gasReserve,
      error: `agent EOA ${opts.agentAddress} has ${formatEther(opts.balance)} 0G; below gas reserve ${formatEther(gasReserve)} 0G`,
    }
  }
  return { value: opts.balance - gasReserve, gasReserve }
}

export async function drainAgentEOA(opts: {
  network: AnimaNetwork
  privkeyHex: Hex
  to: Address
  /** Override the gas reserve (in wei). Default = 21000 * live max-fee. */
  gasReserveWei?: bigint
}): Promise<DrainAgentResult> {
  const { account, publicClient, walletClient, chain } = makeViemClients({
    network: opts.network,
    privkeyHex: opts.privkeyHex,
  })

  const balance = await publicClient.getBalance({ address: account.address })
  const gasPrice = await getGasPriceWithFloor(publicClient)
  const sweep = computeSweepAmount({
    balance,
    gasPrice,
    agentAddress: account.address,
    gasReserveOverride: opts.gasReserveWei,
  })
  if (sweep.error) throw new Error(sweep.error)

  const txHash = await walletClient.sendTransaction({
    account,
    chain,
    to: opts.to,
    value: sweep.value,
    gas: SWEEP_GAS_LIMIT,
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: gasPrice,
  })
  await waitForReceiptResilient(publicClient, txHash)
  return { txHash, amountSent: sweep.value, gasReserved: sweep.gasReserve }
}
