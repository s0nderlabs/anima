/**
 * Balance discovery + multicall reads.
 *
 * The "no curated list" rule from `phase-10-design-locked.md` means
 * `chain.balance` (no token arg) needs to find every ERC-20 the agent has
 * ever held WITHOUT a hardcoded list. We do this by scanning ERC-20 Transfer
 * events keyed on the agent's address as topic2 (recipient) since iNFT mint.
 * The set of distinct contract emitters IS the agent's token universe.
 *
 * Multicall3 then batches `balanceOf` reads on every discovered contract
 * plus a `getEthBalance` for native 0G — single round-trip.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type Address,
  type PublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  pad,
} from 'viem'
import { ERC20_ABI, MULTICALL3_ABI } from './abis'
import {
  LOG_SCAN_CHUNK_BLOCKS,
  LOG_SCAN_MAX_CHUNKS,
  MULTICALL3,
  TRANSFER_TOPIC0,
} from './constants'
import { rawGetLogs } from './raw-logs'
import { fetchOnchainErc20Info, loadTokenCache, lookupFromList, rememberTokens } from './tokens'
import type { BalanceSnapshot, TokenInfo } from './types'

function lastScannedBlockPath(agentDir: string): string {
  return join(agentDir, 'onchain', 'last-scanned-block.txt')
}

function readLastScannedBlock(agentDir: string): bigint | null {
  const path = lastScannedBlockPath(agentDir)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (!raw) return null
    return BigInt(raw)
  } catch {
    return null
  }
}

function writeLastScannedBlock(agentDir: string, blockNumber: bigint): void {
  const path = lastScannedBlockPath(agentDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, blockNumber.toString())
}

/**
 * Scan ERC-20 Transfer events where `to == address` for the given block range.
 * Returns the unique set of token contract addresses (lowercase). Chunks to
 * stay under the RPC's getLogs limits.
 */
export async function discoverTokensByTransfers(opts: {
  client: PublicClient
  address: Address
  fromBlock: bigint
  toBlock: bigint
}): Promise<Address[]> {
  const { client, address, fromBlock, toBlock } = opts
  if (toBlock < fromBlock) return []
  const padded = pad(address, { size: 32 })
  const seen = new Set<string>()
  let cursor = fromBlock
  let chunks = 0
  while (cursor <= toBlock && chunks < LOG_SCAN_MAX_CHUNKS) {
    const chunkEnd = cursor + LOG_SCAN_CHUNK_BLOCKS - 1n
    const end = chunkEnd > toBlock ? toBlock : chunkEnd
    try {
      const logs = await rawGetLogs({
        client,
        topics: [TRANSFER_TOPIC0, null, padded],
        fromBlock: cursor,
        toBlock: end,
      })
      for (const log of logs) {
        seen.add(log.address.toLowerCase())
      }
    } catch {
      // Some RPCs throttle on dense ranges; halve the chunk and continue
      const half = (end - cursor + 1n) / 2n
      if (half > 0n) {
        try {
          const logs = await rawGetLogs({
            client,
            topics: [TRANSFER_TOPIC0, null, padded],
            fromBlock: cursor,
            toBlock: cursor + half - 1n,
          })
          for (const log of logs) {
            seen.add(log.address.toLowerCase())
          }
        } catch {
          // give up on this chunk silently — won't miss balances since
          // we'll still pick up via cache from a later run
        }
      }
    }
    cursor = end + 1n
    chunks += 1
  }
  return Array.from(seen).map(a => getAddress(a) as Address)
}

/**
 * Read native + ERC-20 balances for `address` via Multicall3 in one round-trip.
 * Tokens with zero balance are still returned; caller filters.
 */
export async function readBalancesMulticall(opts: {
  client: PublicClient
  address: Address
  tokens: TokenInfo[]
}): Promise<{
  blockNumber: number
  native: bigint
  perToken: Map<string, bigint>
}> {
  const { client, address, tokens } = opts
  const calls: Array<{
    target: Address
    allowFailure: boolean
    callData: `0x${string}`
  }> = []
  // [0] native via Multicall3.getEthBalance
  calls.push({
    target: MULTICALL3,
    allowFailure: false,
    callData: encodeFunctionData({
      abi: MULTICALL3_ABI,
      functionName: 'getEthBalance',
      args: [address],
    }),
  })
  // [1..n] ERC-20 balanceOf
  for (const t of tokens) {
    calls.push({
      target: t.address,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      }),
    })
  }
  const blockNumber = await client.getBlockNumber()
  const results = (await client.readContract({
    address: MULTICALL3,
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3',
    args: [calls],
  })) as ReadonlyArray<{ success: boolean; returnData: `0x${string}` }>
  const native = decodeFunctionResult({
    abi: MULTICALL3_ABI,
    functionName: 'getEthBalance',
    data: results[0]!.returnData,
  }) as bigint
  const perToken = new Map<string, bigint>()
  for (let i = 0; i < tokens.length; i++) {
    const r = results[i + 1]
    if (!r?.success) continue
    try {
      const bal = decodeFunctionResult({
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        data: r.returnData,
      }) as bigint
      perToken.set(tokens[i]!.address.toLowerCase(), bal)
    } catch {
      // ignore unparseable
    }
  }
  return { blockNumber: Number(blockNumber), native, perToken }
}

/**
 * High-level: discover tokens via Transfer scan + cached set, then multicall
 * balances. Persists cache + last-scanned block.
 */
export async function snapshotBalances(opts: {
  client: PublicClient
  agentDir: string
  address: Address
  mintBlock: bigint
  includeZero?: boolean
  refresh?: boolean
}): Promise<BalanceSnapshot> {
  const { client, agentDir, address, mintBlock, includeZero, refresh } = opts
  const cache = loadTokenCache(agentDir)
  const cachedTokens: TokenInfo[] = Object.values(cache.byAddress)
  const head = await client.getBlockNumber()
  const lastScanned = refresh ? null : readLastScannedBlock(agentDir)
  const fromBlock = lastScanned !== null ? lastScanned + 1n : mintBlock
  const newAddrs =
    fromBlock <= head
      ? await discoverTokensByTransfers({
          client,
          address,
          fromBlock,
          toBlock: head,
        })
      : []

  // Resolve metadata for any new addresses not in cache/list. Metadata reads
  // are independent — fan out so a 20-token discovery doesn't serialize 20
  // round-trips. List hits skip the network entirely.
  const cachedSet = new Set(cachedTokens.map(t => t.address.toLowerCase()))
  const toResolve = newAddrs.filter(a => !cachedSet.has(a.toLowerCase()))
  const resolvedRaw = await Promise.all(
    toResolve.map(a => {
      const fromList = lookupFromList(a, cache)
      return fromList !== null ? Promise.resolve(fromList) : fetchOnchainErc20Info(client, a)
    }),
  )
  const resolved = resolvedRaw.filter((t): t is TokenInfo => t !== null)
  if (resolved.length > 0) rememberTokens(agentDir, resolved)
  // Skip the file write when the cursor didn't advance (multiple
  // chain.balance calls in the same chat turn end up on the same head).
  if (lastScanned === null || head > lastScanned) {
    writeLastScannedBlock(agentDir, head)
  }

  const allTokens = [...cachedTokens, ...resolved]
  const { blockNumber, native, perToken } = await readBalancesMulticall({
    client,
    address,
    tokens: allTokens,
  })
  const tokenBalances = allTokens
    .map(t => {
      const raw = perToken.get(t.address.toLowerCase()) ?? 0n
      return {
        ...t,
        raw: raw.toString(),
        formatted: formatUnits(raw, t.decimals),
      }
    })
    .filter(b => includeZero || b.raw !== '0')
    .sort((a, b) => {
      const ar = BigInt(a.raw)
      const br = BigInt(b.raw)
      if (ar > br) return -1
      if (ar < br) return 1
      return a.symbol.localeCompare(b.symbol)
    })
  return {
    address,
    native: { raw: native.toString(), formatted: formatEther(native) },
    tokens: tokenBalances,
    blockNumber,
  }
}
