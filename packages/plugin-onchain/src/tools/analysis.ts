/**
 * `chain.tx` + `chain.contract` + `chain.activity` — read-only analysis tools.
 */

import type { ToolDef } from '@s0nderlabs/anima-core'
import {
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  pad,
} from 'viem'
import { z } from 'zod'
import { ERC20_ABI, MULTICALL3_ABI } from '../abis'
import { decodeCalldata } from '../analysis'
import {
  EIP1967_IMPL_SLOT,
  ERC165_INTERFACES,
  LOG_SCAN_CHUNK_BLOCKS,
  LOG_SCAN_MAX_CHUNKS,
  MULTICALL3,
  TRANSFER_TOPIC0,
} from '../constants'
import { rawGetLogs } from '../raw-logs'
import { loadTokenCache, lookupFromList } from '../tokens'
import type { OnchainRuntimeContext } from '../types'

const TxSchema = z.object({
  hash: z.string().min(66).describe('0x... 32-byte tx hash'),
})
type TxArgs = z.infer<typeof TxSchema>

function jsonifyArgs(args: unknown[]): unknown[] {
  return args.map(a => {
    if (typeof a === 'bigint') return a.toString()
    if (Array.isArray(a)) return jsonifyArgs(a)
    if (a && typeof a === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
        out[k] = typeof v === 'bigint' ? v.toString() : v
      }
      return out
    }
    return a
  })
}

export function makeChainTx(ctx: OnchainRuntimeContext): ToolDef<TxArgs> {
  return {
    name: 'chain.tx',
    description:
      "Decode any 0G tx hash: from, to, value, status, gas, decoded function call (via vendored ABIs first, 4byte directory fallback), event log summary. ALWAYS call this when the operator gives you a 0x-prefixed hash — do NOT pre-judge whether the hash 'looks valid' by inspecting its bytes; the RPC will return a clean 'tx not found' error if it doesn't exist, and that's the operator-facing source of truth. Skipping the call to call it fake is a hallucination.",
    searchHint: 'transaction tx decode hash receipt analysis',
    schema: TxSchema,
    handler: async args => {
      try {
        const hash = args.hash as `0x${string}`
        const [tx, receipt] = await Promise.all([
          ctx.publicClient.getTransaction({ hash }).catch(() => null),
          ctx.publicClient.getTransactionReceipt({ hash }).catch(() => null),
        ])
        if (!tx || !receipt) {
          return { ok: false, error: `tx not found: ${hash}` }
        }
        const decoded = await decodeCalldata({
          data: tx.input as `0x${string}`,
          agentDir: ctx.agentDir,
        })
        return {
          ok: true,
          data: {
            hash,
            from: tx.from,
            to: tx.to,
            value: tx.value.toString(),
            blockNumber: Number(receipt.blockNumber),
            status: receipt.status === 'success' ? 'success' : 'reverted',
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
            function:
              'name' in decoded
                ? {
                    name: decoded.name,
                    signature: decoded.signature,
                    args: jsonifyArgs(decoded.args),
                    source: decoded.source,
                  }
                : { selector: decoded.selector, source: 'unknown' },
            logs: receipt.logs.map(l => ({
              address: l.address,
              topic0: l.topics[0] ?? null,
              topicCount: l.topics.length,
              dataSize: (l.data.length - 2) / 2,
            })),
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

const ContractSchema = z.object({
  address: z.string().min(42),
})
type ContractArgs = z.infer<typeof ContractSchema>

export function makeChainContract(ctx: OnchainRuntimeContext): ToolDef<ContractArgs> {
  return {
    name: 'chain.contract',
    description:
      'Introspect any 0G contract: bytecode size, EIP-1967 proxy detection, ERC-20/721/1155 interface check, name/symbol if ERC-20.',
    searchHint: 'contract introspect proxy erc20 erc721 supportsInterface',
    schema: ContractSchema,
    handler: async args => {
      try {
        const address = getAddress(args.address) as Address
        const code = await ctx.publicClient.getCode({ address })
        const bytecodeSize = code ? (code.length - 2) / 2 : 0
        const isContract = bytecodeSize > 0
        if (!isContract) {
          return {
            ok: true,
            data: { address, isContract: false, bytecodeSize: 0 },
          }
        }
        const [implRaw, supports721, supports1155] = await Promise.all([
          ctx.publicClient.getStorageAt({ address, slot: EIP1967_IMPL_SLOT }).catch(() => null),
          tryReadSupportsInterface(ctx.publicClient, address, ERC165_INTERFACES.ERC721),
          tryReadSupportsInterface(ctx.publicClient, address, ERC165_INTERFACES.ERC1155),
        ])
        const proxy =
          implRaw && implRaw !== '0x' && implRaw !== `0x${'0'.repeat(64)}`
            ? { implementation: `0x${implRaw.slice(-40)}` as Address }
            : null
        const interfaces: string[] = []
        if (supports721) interfaces.push('ERC721')
        if (supports1155) interfaces.push('ERC1155')
        // ERC-20 detection: try Multicall3 reads of name/symbol/decimals.
        // None of those are mandatory in ERC-20 but in practice every legit
        // token has them; if all three return data, label ERC-20.
        const erc20Calls = [
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
        ]
        const erc20Results = (await ctx.publicClient.readContract({
          address: MULTICALL3,
          abi: MULTICALL3_ABI,
          functionName: 'aggregate3',
          args: [erc20Calls],
        })) as ReadonlyArray<{ success: boolean; returnData: `0x${string}` }>
        let erc20: { name: string; symbol: string; decimals: number } | null = null
        if (erc20Results.length === 3 && erc20Results.every(r => r.success)) {
          try {
            const name = decodeFunctionResult({
              abi: ERC20_ABI,
              functionName: 'name',
              data: erc20Results[0]!.returnData,
            }) as string
            const symbol = decodeFunctionResult({
              abi: ERC20_ABI,
              functionName: 'symbol',
              data: erc20Results[1]!.returnData,
            }) as string
            const decimals = Number(
              decodeFunctionResult({
                abi: ERC20_ABI,
                functionName: 'decimals',
                data: erc20Results[2]!.returnData,
              }) as number,
            )
            erc20 = { name, symbol, decimals }
            interfaces.push('ERC20')
          } catch {
            // not actually an ERC-20
          }
        }
        return {
          ok: true,
          data: {
            address,
            isContract: true,
            bytecodeSize,
            proxy,
            interfaces,
            erc20,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

const SUPPORTS_INTERFACE_SELECTOR = '0x01ffc9a7' // keccak('supportsInterface(bytes4)')[:4]

async function tryReadSupportsInterface(
  client: import('viem').PublicClient,
  address: Address,
  interfaceId: string,
): Promise<boolean> {
  try {
    const data =
      `${SUPPORTS_INTERFACE_SELECTOR}${interfaceId.slice(2).padEnd(64, '0')}` as `0x${string}`
    const out = await client.call({ to: address, data })
    if (!out.data || out.data === '0x') return false
    return out.data.endsWith('1')
  } catch {
    return false
  }
}

const ActivitySchema = z.object({
  address: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
})
type ActivityArgs = z.infer<typeof ActivitySchema>

export function makeChainActivity(ctx: OnchainRuntimeContext): ToolDef<ActivityArgs> {
  return {
    name: 'chain.activity',
    description:
      'Recent ERC-20 Transfer events for an address (in + out) sorted newest-first. Defaults to your wallet, last 50 events.',
    searchHint: 'activity transfers history events recent',
    schema: ActivitySchema,
    handler: async args => {
      try {
        const target = args.address ? (getAddress(args.address) as Address) : ctx.agentEoa
        const limit = args.limit ?? 50
        const head = await ctx.publicClient.getBlockNumber()
        const padded = pad(target, { size: 32 })
        const events: Array<{
          blockNumber: number
          txHash: string
          logIndex: number
          token: string
          from: string
          to: string
          value: bigint
          direction: 'in' | 'out'
        }> = []
        // Walk backwards in chunks until we have `limit` events or hit mintBlock
        let cursor = head
        let chunks = 0
        while (events.length < limit && chunks < LOG_SCAN_MAX_CHUNKS && cursor > ctx.mintBlock) {
          const start = cursor - LOG_SCAN_CHUNK_BLOCKS + 1n
          const from = start > ctx.mintBlock ? start : ctx.mintBlock
          for (const direction of ['in', 'out'] as const) {
            const topics: Array<`0x${string}` | null> =
              direction === 'in' ? [TRANSFER_TOPIC0, null, padded] : [TRANSFER_TOPIC0, padded, null]
            try {
              const logs = await rawGetLogs({
                client: ctx.publicClient,
                topics,
                fromBlock: from,
                toBlock: cursor,
              })
              for (const l of logs) {
                const fromAddr = `0x${(l.topics[1] ?? '').slice(-40)}`
                const toAddr = `0x${(l.topics[2] ?? '').slice(-40)}`
                const value = BigInt(l.data || '0x0')
                events.push({
                  blockNumber: Number(BigInt(l.blockNumber)),
                  txHash: l.transactionHash,
                  logIndex: Number(BigInt(l.logIndex)),
                  token: l.address,
                  from: fromAddr,
                  to: toAddr,
                  value,
                  direction,
                })
              }
            } catch {
              // skip chunk on failure
            }
          }
          cursor = from - 1n
          chunks += 1
        }
        events.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
        const trimmed = events.slice(0, limit)
        const cache = loadTokenCache(ctx.agentDir)
        const decorated = trimmed.map(e => {
          const meta = lookupFromList(e.token, cache)
          return {
            blockNumber: e.blockNumber,
            txHash: e.txHash,
            direction: e.direction,
            token: meta
              ? {
                  symbol: meta.symbol,
                  address: e.token,
                  decimals: meta.decimals,
                  formatted: formatUnits(e.value, meta.decimals),
                }
              : { symbol: '?', address: e.token, decimals: 0, formatted: e.value.toString() },
            from: e.from,
            to: e.to,
            counterparty: e.direction === 'in' ? e.from : e.to,
          }
        })
        return { ok: true, data: { address: target, count: decorated.length, events: decorated } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
