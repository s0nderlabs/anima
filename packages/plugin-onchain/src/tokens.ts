/**
 * Token resolver + cache. Resolution priority:
 *   cache → vendored JAINE list → on-chain ERC-20 reads (Multicall3 batch).
 *
 * The cache lives at <agentDir>/onchain/tokens-cache.json and is keyed by
 * lowercase address. We cache-write whenever an on-chain read succeeds so
 * subsequent runs skip the round-trip.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type Address,
  type PublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
} from 'viem'
import jaineTokenList from '../data/tokens.json' with { type: 'json' }
import { ERC20_ABI, MULTICALL3_ABI } from './abis'
import { MULTICALL3, NATIVE_ALIASES } from './constants'
import type { TokenInfo } from './types'

interface JaineTokenListEntry {
  address: string
  symbol: string
  name: string
  decimals: number
  chainId: number
}

interface JaineTokenList {
  tokens: JaineTokenListEntry[]
}

const TYPED_LIST = jaineTokenList as JaineTokenList

const NATIVE: TokenInfo = {
  address: '0x0000000000000000000000000000000000000000' as Address,
  symbol: '0G',
  name: 'ZeroG',
  decimals: 18,
  source: 'native',
}

export function isNativeToken(input: string | undefined): boolean {
  if (!input) return true
  return NATIVE_ALIASES.has(input.trim())
}

export function nativeTokenInfo(): TokenInfo {
  return { ...NATIVE }
}

function tokensCachePath(agentDir: string): string {
  return join(agentDir, 'onchain', 'tokens-cache.json')
}

interface CacheFile {
  version: 1
  byAddress: Record<string, TokenInfo>
}

function emptyCache(): CacheFile {
  return { version: 1, byAddress: {} }
}

export function loadTokenCache(agentDir: string): CacheFile {
  const path = tokensCachePath(agentDir)
  if (!existsSync(path)) return emptyCache()
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as CacheFile
    if (parsed?.version === 1 && parsed.byAddress) return parsed
    return emptyCache()
  } catch {
    return emptyCache()
  }
}

export function saveTokenCache(agentDir: string, cache: CacheFile): void {
  const path = tokensCachePath(agentDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cache, null, 2))
}

/**
 * Best-effort lookup. Returns the token info if found in cache OR vendored
 * list. On miss, callers should call `fetchOnchainErc20Info` to resolve via
 * RPC and cache-write through.
 */
export function lookupFromList(symbolOrAddress: string, cache: CacheFile): TokenInfo | null {
  const trimmed = symbolOrAddress.trim()
  // Address path
  if (trimmed.startsWith('0x') && trimmed.length === 42) {
    const lc = trimmed.toLowerCase()
    const cached = cache.byAddress[lc]
    if (cached) return cached
    const fromList = TYPED_LIST.tokens.find(t => t.address.toLowerCase() === lc)
    if (fromList) return tokenFromListEntry(fromList)
    return null
  }
  // Symbol path: case-insensitive match
  const upper = trimmed.toUpperCase()
  const fromCache = Object.values(cache.byAddress).find(t => t.symbol.toUpperCase() === upper)
  if (fromCache) return fromCache
  const fromList = TYPED_LIST.tokens.find(t => t.symbol.toUpperCase() === upper)
  if (fromList) return tokenFromListEntry(fromList)
  return null
}

function tokenFromListEntry(e: JaineTokenListEntry): TokenInfo {
  return {
    address: getAddress(e.address) as Address,
    symbol: e.symbol,
    name: e.name,
    decimals: e.decimals,
    source: 'list',
  }
}

/**
 * Read name/symbol/decimals for an ERC-20 via Multicall3 (single round-trip).
 * Tolerates contracts that don't implement `name` (returns symbol as name);
 * decimals + symbol are required. Returns null if the address isn't an ERC-20.
 */
export async function fetchOnchainErc20Info(
  client: PublicClient,
  address: Address,
): Promise<TokenInfo | null> {
  const calls = [
    {
      target: address,
      allowFailure: true,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'name' }),
    },
    {
      target: address,
      allowFailure: true,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'symbol' }),
    },
    {
      target: address,
      allowFailure: true,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'decimals' }),
    },
  ] as const
  let results: ReadonlyArray<{ success: boolean; returnData: `0x${string}` }>
  try {
    results = (await client.readContract({
      address: MULTICALL3,
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      args: [
        calls as unknown as Array<{
          target: Address
          allowFailure: boolean
          callData: `0x${string}`
        }>,
      ],
    })) as ReadonlyArray<{ success: boolean; returnData: `0x${string}` }>
  } catch {
    return null
  }
  const decode = <T>(idx: number, fnName: 'name' | 'symbol' | 'decimals'): T | null => {
    const r = results[idx]
    if (!r?.success) return null
    try {
      return decodeFunctionResult({
        abi: ERC20_ABI,
        functionName: fnName,
        data: r.returnData,
      }) as T
    } catch {
      return null
    }
  }
  const symbol = decode<string>(1, 'symbol')
  const decimals = decode<number>(2, 'decimals')
  if (symbol == null || decimals == null) return null
  const name = decode<string>(0, 'name') ?? symbol
  return {
    address: getAddress(address) as Address,
    symbol,
    name,
    decimals: Number(decimals),
    source: 'onchain',
  }
}

/** Resolve, with cache-write-through on on-chain hits. */
export async function resolveToken(opts: {
  client: PublicClient
  agentDir: string
  input: string
}): Promise<TokenInfo | null> {
  const { client, agentDir, input } = opts
  if (isNativeToken(input)) return nativeTokenInfo()
  const cache = loadTokenCache(agentDir)
  const local = lookupFromList(input, cache)
  if (local) return local
  // Fall through to on-chain only for address inputs
  if (input.startsWith('0x') && input.length === 42) {
    const fetched = await fetchOnchainErc20Info(client, input as Address)
    if (fetched) {
      const updated: CacheFile = {
        version: 1,
        byAddress: { ...cache.byAddress, [fetched.address.toLowerCase()]: fetched },
      }
      saveTokenCache(agentDir, updated)
      return fetched
    }
  }
  return null
}

/** Persist a known-good token info (e.g. from balance discovery) to cache. */
export function rememberToken(agentDir: string, token: TokenInfo): void {
  const cache = loadTokenCache(agentDir)
  cache.byAddress[token.address.toLowerCase()] = token
  saveTokenCache(agentDir, cache)
}

/** Bulk variant for after a discovery scan. */
export function rememberTokens(agentDir: string, tokens: TokenInfo[]): void {
  if (tokens.length === 0) return
  const cache = loadTokenCache(agentDir)
  for (const t of tokens) {
    cache.byAddress[t.address.toLowerCase()] = t
  }
  saveTokenCache(agentDir, cache)
}
