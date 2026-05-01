/**
 * One-shot iNFT mint block discovery for the Transfer-event scan floor.
 *
 * Uses `rawGetLogs` to bypass viem's `getLogs` topic-stripping (verified May
 * 1 2026; without raw, the call falls through to "topics:[]" and the 0G RPC
 * rejects with "result set exceeds 10000 logs"). Walks recent → old in
 * 50k-block chunks, capped at LOG_SCAN_MAX_CHUNKS, and returns the first
 * (newest) match. iNFT mint Transfers have `from = 0x0` and `tokenId` in
 * topic3, so the filter is precise.
 */

import type { Address, PublicClient } from 'viem'
import { LOG_SCAN_CHUNK_BLOCKS, LOG_SCAN_MAX_CHUNKS, TRANSFER_TOPIC0 } from './constants'
import { rawGetLogs } from './raw-logs'

function pad32(hex: string): `0x${string}` {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex
  return `0x${stripped.padStart(64, '0')}` as `0x${string}`
}

export async function discoverMintBlock(
  client: PublicClient,
  contract: Address,
  tokenId: bigint,
): Promise<bigint | null> {
  const head = await client.getBlockNumber()
  const tokenIdTopic = pad32(tokenId.toString(16))
  const fromZeroTopic = pad32('0')
  let cursor = head
  for (let chunks = 0; chunks < LOG_SCAN_MAX_CHUNKS && cursor > 0n; chunks++) {
    const start = cursor - LOG_SCAN_CHUNK_BLOCKS + 1n
    const from = start > 0n ? start : 0n
    try {
      const logs = await rawGetLogs({
        client,
        address: contract,
        topics: [TRANSFER_TOPIC0, fromZeroTopic, null, tokenIdTopic],
        fromBlock: from,
        toBlock: cursor,
      })
      if (logs.length > 0) {
        const earliest = logs.reduce((acc, l) =>
          BigInt(l.blockNumber) < BigInt(acc.blockNumber) ? l : acc,
        )
        return BigInt(earliest.blockNumber)
      }
    } catch {
      // RPC chunk failure; keep walking.
    }
    cursor = from - 1n
  }
  return null
}
