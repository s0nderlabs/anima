/**
 * `chain.wrap` + `chain.unwrap` — native ↔ W0G via WETH9 deposit/withdraw.
 */

import type { ToolDef } from '@s0nderlabs/anima-core'
import { getGasPriceWithFloor } from '@s0nderlabs/anima-core'
import { type Address, formatEther, parseEther } from 'viem'
import { z } from 'zod'
import { WETH9_ABI } from '../abis'
import { JAINE_BY_NETWORK, requireMainnet } from '../constants'
import type { OnchainRuntimeContext } from '../types'
import { waitForReceipt } from '../wait-receipt'

const WrapSchema = z.object({
  amount: z.string().min(1).describe('Amount of 0G to wrap (e.g. "0.05").'),
})
type WrapArgs = z.infer<typeof WrapSchema>

export function makeChainWrap(ctx: OnchainRuntimeContext): ToolDef<WrapArgs> {
  return {
    name: 'chain.wrap',
    description:
      'Wrap native 0G into W0G (ERC-20). Calls W0G.deposit() with msg.value. Required when agent needs to swap with ERC-20 input on JAINE.',
    searchHint: 'wrap 0g w0g weth deposit erc20',
    schema: WrapSchema,
    handler: async args => {
      try {
        requireMainnet(ctx.network)
        const w0g = JAINE_BY_NETWORK[ctx.network]!.weth9
        const account = ctx.walletClient.account
        if (!account) {
          return { ok: false, error: 'walletClient has no account; cannot wrap' }
        }
        const value = parseEther(args.amount)
        const gasPrice = await getGasPriceWithFloor(ctx.publicClient)
        const txHash = await ctx.walletClient.writeContract({
          address: w0g as Address,
          abi: WETH9_ABI,
          functionName: 'deposit',
          value,
          chain: ctx.walletClient.chain,
          account,
          gasPrice,
        })
        const receipt = await waitForReceipt(ctx.publicClient, txHash)
        const w0gBal = (await ctx.publicClient.readContract({
          address: w0g as Address,
          abi: WETH9_ABI,
          functionName: 'balanceOf',
          args: [ctx.agentEoa],
        })) as bigint
        const nativeBal = await ctx.publicClient.getBalance({ address: ctx.agentEoa })
        return {
          ok: true,
          data: {
            txHash,
            blockNumber: Number(receipt.blockNumber),
            gasUsed: receipt.gasUsed.toString(),
            wrappedAmount: args.amount,
            w0gBalance: formatEther(w0gBal),
            nativeBalance: formatEther(nativeBal),
            status: receipt.status === 'success' ? 'success' : 'reverted',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

const UnwrapSchema = z.object({
  amount: z.string().min(1).describe('Amount of W0G to unwrap, or "all" for entire W0G balance.'),
})
type UnwrapArgs = z.infer<typeof UnwrapSchema>

export function makeChainUnwrap(ctx: OnchainRuntimeContext): ToolDef<UnwrapArgs> {
  return {
    name: 'chain.unwrap',
    description:
      'Unwrap W0G back into native 0G. Calls W0G.withdraw(amount). Pass "all" to unwrap entire balance.',
    searchHint: 'unwrap w0g 0g native withdraw',
    schema: UnwrapSchema,
    handler: async args => {
      try {
        requireMainnet(ctx.network)
        const w0g = JAINE_BY_NETWORK[ctx.network]!.weth9
        const account = ctx.walletClient.account
        if (!account) {
          return { ok: false, error: 'walletClient has no account; cannot unwrap' }
        }
        let amountWei: bigint
        if (args.amount === 'all') {
          amountWei = (await ctx.publicClient.readContract({
            address: w0g as Address,
            abi: WETH9_ABI,
            functionName: 'balanceOf',
            args: [ctx.agentEoa],
          })) as bigint
          if (amountWei === 0n) {
            return { ok: false, error: 'no W0G balance to unwrap' }
          }
        } else {
          amountWei = parseEther(args.amount)
        }
        const gasPrice = await getGasPriceWithFloor(ctx.publicClient)
        const txHash = await ctx.walletClient.writeContract({
          address: w0g as Address,
          abi: WETH9_ABI,
          functionName: 'withdraw',
          args: [amountWei],
          chain: ctx.walletClient.chain,
          account,
          gasPrice,
        })
        const receipt = await waitForReceipt(ctx.publicClient, txHash)
        const w0gBal = (await ctx.publicClient.readContract({
          address: w0g as Address,
          abi: WETH9_ABI,
          functionName: 'balanceOf',
          args: [ctx.agentEoa],
        })) as bigint
        const nativeBal = await ctx.publicClient.getBalance({ address: ctx.agentEoa })
        return {
          ok: true,
          data: {
            txHash,
            blockNumber: Number(receipt.blockNumber),
            gasUsed: receipt.gasUsed.toString(),
            unwrappedAmount: formatEther(amountWei),
            w0gBalance: formatEther(w0gBal),
            nativeBalance: formatEther(nativeBal),
            status: receipt.status === 'success' ? 'success' : 'reverted',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
