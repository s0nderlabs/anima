/**
 * `chain.balance` — read native + ERC-20 balances.
 *
 * - No args: full discovered snapshot (Multicall3 + Transfer-event scan).
 * - `token` arg: single token. Native if symbol ∈ {0G, OG, native}; else
 *   resolves via `tokens.ts` cache → list → on-chain.
 * - `address` arg: read for any address (default = agent EOA).
 */

import type { ToolDef } from '@s0nderlabs/anima-core'
import { type Address, formatEther, formatUnits, getAddress } from 'viem'
import { z } from 'zod'
import { ERC20_ABI } from '../abis'
import { snapshotBalances } from '../balances'
import { isNativeToken, nativeTokenInfo, resolveToken } from '../tokens'
import type { OnchainRuntimeContext } from '../types'

const Schema = z.object({
  token: z
    .string()
    .optional()
    .describe(
      'Optional symbol or 0x address. Omit for the full holdings snapshot. Use "0G"/"native" for native.',
    ),
  address: z
    .string()
    .optional()
    .describe('Optional 0x address to inspect (default: your agent EOA).'),
  refresh: z
    .boolean()
    .optional()
    .describe(
      'Force re-discovery from the iNFT mint block (ignore cached last-scanned block). Slower; use after a tx if the cache looks stale.',
    ),
})
type Args = z.infer<typeof Schema>

export function makeChainBalance(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'chain.balance',
    description:
      'Read native + ERC-20 balances on 0G. No args = full discovered snapshot for your wallet (Multicall3 + Transfer-event auto-discovery; no curated list). Pass `token` for a specific asset, `address` to inspect another wallet.',
    searchHint: 'wallet balance erc20 native holdings discover',
    schema: Schema,
    handler: async args => {
      try {
        const target = args.address ? (getAddress(args.address) as Address) : ctx.agentEoa
        if (args.token) {
          if (isNativeToken(args.token)) {
            const wei = await ctx.publicClient.getBalance({ address: target })
            const native = nativeTokenInfo()
            return {
              ok: true,
              data: {
                address: target,
                token: native.symbol,
                raw: wei.toString(),
                formatted: formatEther(wei),
                decimals: native.decimals,
              },
            }
          }
          const token = await resolveToken({
            client: ctx.publicClient,
            agentDir: ctx.agentDir,
            input: args.token,
          })
          if (!token) {
            return {
              ok: false,
              error: `unknown token: ${args.token}. Try a 0x address.`,
            }
          }
          const wei = (await ctx.publicClient.readContract({
            address: token.address,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [target],
          })) as bigint
          return {
            ok: true,
            data: {
              address: target,
              token: token.symbol,
              tokenAddress: token.address,
              raw: wei.toString(),
              formatted: formatUnits(wei, token.decimals),
              decimals: token.decimals,
            },
          }
        }
        const snap = await snapshotBalances({
          client: ctx.publicClient,
          agentDir: ctx.agentDir,
          address: target,
          mintBlock: ctx.mintBlock,
          refresh: args.refresh ?? false,
        })
        return {
          ok: true,
          data: {
            address: snap.address,
            blockNumber: snap.blockNumber,
            native: snap.native,
            tokens: snap.tokens.map(t => ({
              symbol: t.symbol,
              address: t.address,
              decimals: t.decimals,
              raw: t.raw,
              formatted: t.formatted,
            })),
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
