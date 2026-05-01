/**
 * `chain.send` — native or ERC-20 transfer.
 */

import type { ToolDef } from '@s0nderlabs/anima-core'
import { getGasPriceWithFloor } from '@s0nderlabs/anima-core'
import { type Address, getAddress, parseEther, parseUnits } from 'viem'
import { z } from 'zod'
import { ERC20_ABI } from '../abis'
import { isNativeToken, resolveToken } from '../tokens'
import type { OnchainRuntimeContext } from '../types'
import { waitForReceipt } from '../wait-receipt'

const Schema = z.object({
  to: z.string().min(42).describe('Recipient 0x address.'),
  amount: z.string().min(1).describe('Amount in token units (e.g. "0.05" for 0.05 0G).'),
  token: z
    .string()
    .optional()
    .describe('Symbol or 0x address. Omit / "0G" / "native" for native transfer.'),
})
type Args = z.infer<typeof Schema>

export function makeChainSend(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'chain.send',
    description:
      'Transfer 0G or any ERC-20 from your agent EOA. Pass `token` for ERC-20; omit for native 0G. Auto-detects decimals via tokens.info.',
    searchHint: 'send transfer 0g native erc20 pay',
    schema: Schema,
    handler: async args => {
      try {
        const recipient = getAddress(args.to) as Address
        const account = ctx.walletClient.account
        if (!account) {
          return { ok: false, error: 'walletClient has no account; cannot send' }
        }
        const gasPrice = await getGasPriceWithFloor(ctx.publicClient)
        if (isNativeToken(args.token)) {
          const value = parseEther(args.amount)
          const txHash = await ctx.walletClient.sendTransaction({
            to: recipient,
            value,
            chain: ctx.walletClient.chain,
            account,
            gasPrice,
          })
          const receipt = await waitForReceipt(ctx.publicClient, txHash)
          return {
            ok: true,
            data: {
              txHash,
              blockNumber: Number(receipt.blockNumber),
              gasUsed: receipt.gasUsed.toString(),
              token: '0G',
              amount: args.amount,
              recipient,
              status: receipt.status === 'success' ? 'success' : 'reverted',
            },
          }
        }
        const token = await resolveToken({
          client: ctx.publicClient,
          agentDir: ctx.agentDir,
          input: args.token!,
        })
        if (!token) {
          return { ok: false, error: `unknown token: ${args.token}` }
        }
        const value = parseUnits(args.amount, token.decimals)
        const txHash = await ctx.walletClient.writeContract({
          address: token.address,
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [recipient, value],
          chain: ctx.walletClient.chain,
          account,
          gasPrice,
        })
        const receipt = await waitForReceipt(ctx.publicClient, txHash)
        return {
          ok: true,
          data: {
            txHash,
            blockNumber: Number(receipt.blockNumber),
            gasUsed: receipt.gasUsed.toString(),
            token: token.symbol,
            tokenAddress: token.address,
            amount: args.amount,
            amountRaw: value.toString(),
            recipient,
            status: receipt.status === 'success' ? 'success' : 'reverted',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
