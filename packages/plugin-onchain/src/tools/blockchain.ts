/**
 * `chain.block` + `chain.gas` — passive RPC introspection.
 */

import type { ToolDef } from '@s0nderlabs/anima-core'
import { getGasPriceWithFloor } from '@s0nderlabs/anima-core'
import { formatGwei } from 'viem'
import { z } from 'zod'
import type { OnchainRuntimeContext } from '../types'

const BlockSchema = z.object({
  tag: z
    .union([
      z.enum(['latest', 'finalized', 'safe', 'earliest', 'pending']),
      z.number().int().nonnegative(),
    ])
    .optional()
    .describe('Block tag or number (default: "latest").'),
})
type BlockArgs = z.infer<typeof BlockSchema>

export function makeChainBlock(ctx: OnchainRuntimeContext): ToolDef<BlockArgs> {
  return {
    name: 'chain.block',
    description:
      'Read a 0G block summary (number, hash, timestamp, txCount, gasUsed). Default: latest.',
    searchHint: 'block number height timestamp head',
    schema: BlockSchema,
    handler: async args => {
      try {
        const tag = args.tag ?? 'latest'
        const block =
          typeof tag === 'number'
            ? await ctx.publicClient.getBlock({ blockNumber: BigInt(tag) })
            : await ctx.publicClient.getBlock({ blockTag: tag })
        return {
          ok: true,
          data: {
            number: Number(block.number ?? 0n),
            hash: block.hash,
            parentHash: block.parentHash,
            timestamp: Number(block.timestamp),
            txCount: block.transactions.length,
            gasUsed: block.gasUsed.toString(),
            gasLimit: block.gasLimit.toString(),
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

const GasSchema = z.object({})
type GasArgs = z.infer<typeof GasSchema>

export function makeChainGas(ctx: OnchainRuntimeContext): ToolDef<GasArgs> {
  return {
    name: 'chain.gas',
    description:
      'Current 0G gas price with the network floor applied (4 gwei min). Use to estimate cost or detect spikes.',
    searchHint: 'gas price gwei fee estimate',
    schema: GasSchema,
    handler: async () => {
      try {
        const wei = await getGasPriceWithFloor(ctx.publicClient)
        return {
          ok: true,
          data: {
            gasPriceWei: wei.toString(),
            gasPriceGwei: formatGwei(wei),
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
