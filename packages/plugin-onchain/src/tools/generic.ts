/**
 * `chain.read` + `chain.write` — generic ABI-call escape hatch for contracts
 * not covered by the curated tools.
 *
 * Argument format mirrors `cast`:
 *   - `signature: 'balanceOf(address)'`
 *   - `args: ['0xabc...']`
 * Decimal numbers are auto-converted to bigint (zod number → BigInt) to keep
 * the interface friendly for the LLM. Hex strings stay as-is.
 */

import type { ToolDef } from '@s0nderlabs/anima-core'
import { getGasPriceWithFloor } from '@s0nderlabs/anima-core'
import {
  type Address,
  decodeAbiParameters,
  encodeFunctionData,
  getAddress,
  parseAbiItem,
  parseAbiParameters,
  parseEther,
} from 'viem'
import { z } from 'zod'
import type { OnchainRuntimeContext } from '../types'
import { waitForReceipt } from '../wait-receipt'

const ReadSchema = z.object({
  to: z.string().min(42).describe('0x contract address.'),
  signature: z
    .string()
    .min(1)
    .describe('Function signature, e.g. "balanceOf(address)" or "totalSupply()".'),
  args: z.array(z.unknown()).optional().describe('Encoded args matching signature.'),
  returnTypes: z
    .array(z.string())
    .optional()
    .describe('Optional explicit return types for decoding (e.g. ["uint256"]).'),
})
type ReadArgs = z.infer<typeof ReadSchema>

function coerceArg(raw: unknown): unknown {
  if (typeof raw === 'string') {
    if (/^-?\d+$/.test(raw) && !raw.startsWith('0x')) {
      try {
        return BigInt(raw)
      } catch {
        return raw
      }
    }
    return raw
  }
  if (typeof raw === 'number') {
    return BigInt(raw)
  }
  if (Array.isArray(raw)) return raw.map(coerceArg)
  return raw
}

function buildAbiFunction(signature: string): import('viem').AbiFunction {
  const trimmed = signature.trim()
  const text = trimmed.startsWith('function ') ? trimmed : `function ${trimmed}`
  const item = parseAbiItem(text)
  if (typeof item !== 'object' || item.type !== 'function') {
    throw new Error(`could not parse function signature: ${signature}`)
  }
  return item as import('viem').AbiFunction
}

export function makeChainRead(ctx: OnchainRuntimeContext): ToolDef<ReadArgs> {
  return {
    name: 'chain.read',
    description:
      'Generic eth_call. Pass `signature` (e.g. "balanceOf(address)") + `args`. Returns hex `data` plus a decoded version when `returnTypes` provided OR the signature itself includes returns.',
    searchHint: 'read view eth_call generic abi cast',
    schema: ReadSchema,
    handler: async args => {
      try {
        const fn = buildAbiFunction(args.signature)
        const coerced = (args.args ?? []).map(coerceArg)
        const data = encodeFunctionData({
          abi: [fn] as readonly [import('viem').AbiFunction],
          args: coerced,
        })
        const result = await ctx.publicClient.call({
          to: getAddress(args.to) as Address,
          data,
        })
        const raw = result.data ?? '0x'
        let decoded: unknown[] | null = null
        if (args.returnTypes && args.returnTypes.length > 0) {
          try {
            const params = parseAbiParameters(args.returnTypes.join(', '))
            decoded = [...decodeAbiParameters(params, raw)]
          } catch {
            decoded = null
          }
        } else if (fn.outputs && fn.outputs.length > 0) {
          try {
            decoded = [...decodeAbiParameters(fn.outputs as never, raw)]
          } catch {
            decoded = null
          }
        }
        return {
          ok: true,
          data: {
            to: getAddress(args.to),
            signature: args.signature,
            raw,
            decoded:
              decoded === null
                ? null
                : decoded.map(d => (typeof d === 'bigint' ? d.toString() : d)),
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

const WriteSchema = z.object({
  to: z.string().min(42),
  signature: z.string().min(1),
  args: z.array(z.unknown()).optional(),
  value: z
    .string()
    .optional()
    .describe(
      'Native value to send. Accepts decimal 0G ("0.0001") OR wei integer ("100000000000000").',
    ),
})
type WriteArgs = z.infer<typeof WriteSchema>

export function parseChainWriteValue(raw: string): bigint {
  const trimmed = raw.trim()
  if (trimmed.includes('.')) {
    return parseEther(trimmed as `${number}`)
  }
  return BigInt(trimmed)
}

export function makeChainWrite(ctx: OnchainRuntimeContext): ToolDef<WriteArgs> {
  return {
    name: 'chain.write',
    description:
      'Generic state-changing call. Pass `signature` + `args` (+ optional `value`). Routes through approval modal in `prompt` mode.',
    searchHint: 'write contract send call generic state-change',
    schema: WriteSchema,
    handler: async args => {
      try {
        const account = ctx.walletClient.account
        if (!account) return { ok: false, error: 'walletClient has no account; cannot write' }
        const fn = buildAbiFunction(args.signature)
        const coerced = (args.args ?? []).map(coerceArg)
        const data = encodeFunctionData({
          abi: [fn] as readonly [import('viem').AbiFunction],
          args: coerced,
        })
        const value = args.value ? parseChainWriteValue(args.value) : 0n
        const gasPrice = await getGasPriceWithFloor(ctx.publicClient)
        const txHash = await ctx.walletClient.sendTransaction({
          to: getAddress(args.to) as Address,
          data,
          value,
          chain: ctx.walletClient.chain,
          account,
          gasPrice,
        })
        const receipt = await waitForReceipt(ctx.publicClient, txHash)
        return {
          ok: true,
          data: {
            txHash,
            blockNumber: Number(receipt.blockNumber),
            gasUsed: receipt.gasUsed.toString(),
            status: receipt.status === 'success' ? 'success' : 'reverted',
            to: getAddress(args.to),
            value: value.toString(),
            signature: args.signature,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
