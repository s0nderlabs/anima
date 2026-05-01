/**
 * `tokens.info` — resolve a symbol or address to token metadata.
 *
 * Source priority: cache → vendored JAINE list → on-chain ERC-20 reads
 * (cache-write-through). Returns `{symbol, name, address, decimals, source}`.
 */

import type { ToolDef } from '@s0nderlabs/anima-core'
import { z } from 'zod'
import { isNativeToken, nativeTokenInfo, resolveToken } from '../tokens'
import type { OnchainRuntimeContext } from '../types'

const Schema = z.object({
  symbol: z.string().optional().describe('Symbol (e.g. "USDCe", "stOG", "0G").'),
  address: z.string().optional().describe('0x token contract address.'),
})
type Args = z.infer<typeof Schema>

export function makeTokensInfo(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'tokens.info',
    description:
      'Resolve a token symbol or address to {symbol, name, address, decimals, source}. Tries local cache → vendored JAINE token list → on-chain ERC-20 reads (cached after).',
    searchHint: 'token metadata symbol decimals erc20 lookup',
    schema: Schema,
    handler: async args => {
      try {
        const input = args.symbol ?? args.address ?? ''
        if (!input) {
          return { ok: false, error: 'provide one of `symbol` or `address`' }
        }
        if (isNativeToken(input)) {
          return { ok: true, data: nativeTokenInfo() }
        }
        const token = await resolveToken({
          client: ctx.publicClient,
          agentDir: ctx.agentDir,
          input,
        })
        if (!token) {
          return { ok: false, error: `token not found: ${input}` }
        }
        return { ok: true, data: token }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
