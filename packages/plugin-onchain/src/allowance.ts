/**
 * Shared ERC-20 allowance helper. Reads current allowance via Multicall3,
 * sends approve(spender, maxUint256) only if insufficient. Used by
 * `swap.execute` (router) and `stake.unstake` (Gimo pool).
 */

import { getGasPriceWithFloor } from '@s0nderlabs/anima-core'
import {
  type Address,
  type PublicClient,
  type WalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  maxUint256,
} from 'viem'
import { ERC20_ABI, MULTICALL3_ABI } from './abis'
import { MULTICALL3 } from './constants'
import { waitForReceipt } from './wait-receipt'

export async function readAllowance(opts: {
  client: PublicClient
  token: Address
  owner: Address
  spender: Address
}): Promise<bigint> {
  const { client, token, owner, spender } = opts
  const calls = [
    {
      target: token,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [owner, spender],
      }),
    },
  ]
  const results = (await client.readContract({
    address: MULTICALL3,
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3',
    args: [calls],
  })) as ReadonlyArray<{ success: boolean; returnData: `0x${string}` }>
  return decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: 'allowance',
    data: results[0]!.returnData,
  }) as bigint
}

export async function ensureAllowance(opts: {
  publicClient: PublicClient
  walletClient: WalletClient
  token: Address
  owner: Address
  spender: Address
  amount: bigint
}): Promise<{ approved: boolean; txHash?: `0x${string}` }> {
  const { publicClient, walletClient, token, owner, spender, amount } = opts
  const current = await readAllowance({ client: publicClient, token, owner, spender })
  if (current >= amount) return { approved: false }
  const gasPrice = await getGasPriceWithFloor(publicClient)
  const account = walletClient.account
  if (!account) throw new Error('walletClient has no account; cannot approve')
  const txHash = await walletClient.writeContract({
    address: getAddress(token) as Address,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, maxUint256],
    chain: walletClient.chain,
    account,
    gasPrice,
  })
  await waitForReceipt(publicClient, txHash)
  return { approved: true, txHash }
}
