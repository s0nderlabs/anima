/**
 * Swap calldata builder + multicall composer for JAINE.
 *
 * Three native-handling cases (verified live on mainnet May 1):
 *   1. native IN  → multicall([exactInputSingle(tokenIn=W0G, ...), refundETH()])
 *      with msg.value=amountIn
 *   2. native OUT → multicall([exactInputSingle(recipient=router, ...), unwrapWETH9(min, recipient)])
 *   3. ERC-20 ↔ ERC-20 → direct exactInputSingle (recipient=agent)
 *
 * The router is the OLD SwapRouter (NOT SwapRouter02). Struct includes
 * `deadline: uint256`. Vendored ABI in abis/swap-router.json.
 */

import { type Address, encodeFunctionData } from 'viem'
import { SWAP_ROUTER_ABI } from './abis'

export interface ExactInputSingleParams {
  tokenIn: Address
  tokenOut: Address
  fee: number
  recipient: Address
  deadline: bigint
  amountIn: bigint
  amountOutMinimum: bigint
  sqrtPriceLimitX96: bigint
}

export function encodeExactInputSingle(params: ExactInputSingleParams): `0x${string}` {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [params],
  })
}

export function encodeRefundETH(): `0x${string}` {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'refundETH',
    args: [],
  })
}

export function encodeUnwrapWETH9(amountMin: bigint, recipient: Address): `0x${string}` {
  return encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: 'unwrapWETH9',
    args: [amountMin, recipient],
  })
}

export interface ComposeArgs {
  params: ExactInputSingleParams
  nativeIn: boolean
  nativeOut: boolean
  router: Address
}

export interface ComposedCall {
  to: Address
  data: `0x${string}`
  value: bigint
}

/**
 * Produce the (to, data, value) for a single swap tx, handling native
 * in/out via multicall composition.
 */
export function composeSwap({ params, nativeIn, nativeOut, router }: ComposeArgs): ComposedCall {
  if (nativeIn && nativeOut) {
    throw new Error('nativeIn AND nativeOut not supported (use chain.wrap/unwrap)')
  }
  if (nativeIn) {
    const calls = [encodeExactInputSingle(params), encodeRefundETH()]
    return {
      to: router,
      data: encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: 'multicall',
        args: [calls],
      }),
      value: params.amountIn,
    }
  }
  if (nativeOut) {
    // Inner exactInputSingle's recipient must be the router so it holds W0G
    // for the unwrap step. Outer unwrap sends native to the agent.
    const innerParams: ExactInputSingleParams = { ...params, recipient: router }
    const calls = [
      encodeExactInputSingle(innerParams),
      encodeUnwrapWETH9(params.amountOutMinimum, params.recipient),
    ]
    return {
      to: router,
      data: encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: 'multicall',
        args: [calls],
      }),
      value: 0n,
    }
  }
  return {
    to: router,
    data: encodeExactInputSingle(params),
    value: 0n,
  }
}
