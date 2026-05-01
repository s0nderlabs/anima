/**
 * Raw `eth_getLogs` wrapper that bypasses viem's `getLogs` topic-stripping.
 *
 * viem v2's `getLogs({topics: [t0, null, t1]})` reorders/strips topic slots
 * when no `event` parsed input is supplied, leaving the RPC with `topics:[]`
 * (verified May 1 2026 against 0G mainnet RPC). The 0G RPC then rejects with
 * "result set exceeds max limit of 10000 logs" because the broad query
 * matches every Transfer on chain.
 *
 * This helper sends the JSON-RPC payload verbatim, preserving sparse topic
 * filtering exactly as the user wrote it.
 */

import { type PublicClient, numberToHex } from 'viem'

export interface RawLog {
  address: `0x${string}`
  blockNumber: `0x${string}`
  blockHash: `0x${string}`
  transactionHash: `0x${string}`
  transactionIndex: `0x${string}`
  logIndex: `0x${string}`
  data: `0x${string}`
  topics: `0x${string}`[]
}

export interface RawLogsArgs {
  client: PublicClient
  address?: `0x${string}` | `0x${string}`[]
  topics: Array<`0x${string}` | null | `0x${string}`[]>
  fromBlock: bigint
  toBlock: bigint
}

export async function rawGetLogs(args: RawLogsArgs): Promise<RawLog[]> {
  const { client, address, topics, fromBlock, toBlock } = args
  const params: Record<string, unknown> = {
    topics,
    fromBlock: numberToHex(fromBlock),
    toBlock: numberToHex(toBlock),
  }
  if (address !== undefined) params.address = address
  // biome-ignore lint/suspicious/noExplicitAny: viem PublicClient lacks .request in TS, but it exists
  const result = await (client as any).request({
    method: 'eth_getLogs',
    params: [params],
  })
  return (result as RawLog[]) ?? []
}
