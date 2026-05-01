/**
 * JAINE 3-tier quote scan via Factory.getPool + Quoter V1.
 *
 * Critical gotcha (verified May 1 2026 cast probes): JAINE Quoter is V1 (5
 * flat args), NOT V2 (single struct). V2 ABI silently mis-encodes and the
 * call reverts. Pinned via the vendored testnet artifact whose bytecode is
 * equivalent to mainnet.
 */

import { type Address, type PublicClient, decodeFunctionResult, encodeFunctionData } from 'viem'
import { FACTORY_ABI, MULTICALL3_ABI, QUOTER_ABI } from './abis'
import { FEE_TIERS, type FeeTier, JAINE_BY_NETWORK, MULTICALL3, requireMainnet } from './constants'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

export interface QuoteResult {
  fee: FeeTier
  amountOut: bigint
  pool: Address
}

/**
 * Iterate the 3 fee tiers, batch-call factory.getPool via multicall3.
 * For non-zero pools, call quoter.quoteExactInputSingle one at a time
 * (the quoter's revert behavior on zero-liquidity pools makes batching
 * unsafe — a single missing quote would tank the whole multicall).
 *
 * Returns the tier with the highest amountOut, or null if no JAINE pool exists
 * across any tier.
 */
export async function quoteAcrossTiers(opts: {
  client: PublicClient
  network: '0g-mainnet'
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
}): Promise<QuoteResult | null> {
  const { client, network, tokenIn, tokenOut, amountIn } = opts
  requireMainnet(network)
  const jaine = JAINE_BY_NETWORK[network]!
  // Step 1: batch-fetch all 3 pool addresses
  const poolCalls = FEE_TIERS.map(fee => ({
    target: jaine.factory,
    allowFailure: false,
    callData: encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: 'getPool',
      args: [tokenIn, tokenOut, fee],
    }),
  }))
  const poolResults = (await client.readContract({
    address: MULTICALL3,
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3',
    args: [poolCalls],
  })) as ReadonlyArray<{ success: boolean; returnData: `0x${string}` }>
  const pools = FEE_TIERS.map((fee, i) => {
    const r = poolResults[i]
    if (!r?.success) return { fee, pool: ZERO_ADDRESS }
    const addr = decodeFunctionResult({
      abi: FACTORY_ABI,
      functionName: 'getPool',
      data: r.returnData,
    }) as Address
    return { fee, pool: addr }
  }).filter(p => p.pool.toLowerCase() !== ZERO_ADDRESS.toLowerCase())
  if (pools.length === 0) return null
  // Step 2: quote each non-zero pool sequentially
  const candidates: QuoteResult[] = []
  for (const p of pools) {
    try {
      const amountOut = (await client.readContract({
        address: jaine.quoter,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn, tokenOut, p.fee, amountIn, 0n],
      })) as bigint
      if (amountOut > 0n) {
        candidates.push({ fee: p.fee, amountOut, pool: p.pool })
      }
    } catch {
      // pool exists but no liquidity at this size; skip
    }
  }
  if (candidates.length === 0) return null
  return candidates.reduce((best, c) => (c.amountOut > best.amountOut ? c : best))
}
