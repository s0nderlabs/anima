/**
 * `account.info` — wallet + iNFT + brain + activity bundle in one call.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDef } from '@s0nderlabs/anima-core'
import { z } from 'zod'
import { snapshotBalances } from '../balances'
import type { OnchainRuntimeContext } from '../types'

const Schema = z.object({})
type Args = z.infer<typeof Schema>

export function makeAccountInfo(ctx: OnchainRuntimeContext): ToolDef<Args> {
  return {
    name: 'account.info',
    description:
      'Bundle of agent wallet snapshot + iNFT identity + brain provider + last 5 activity entries. Single round-trip via Multicall3.',
    searchHint: 'identity wallet snapshot account info self',
    schema: Schema,
    handler: async () => {
      try {
        const [snap, computeBalance, recent] = await Promise.all([
          snapshotBalances({
            client: ctx.publicClient,
            agentDir: ctx.agentDir,
            address: ctx.agentEoa,
            mintBlock: ctx.mintBlock,
          }),
          ctx.brokerLedger?.balance0G().catch(() => null) ?? Promise.resolve(null),
          readRecentActivity(ctx.agentDir, 5),
        ])
        return {
          ok: true,
          data: {
            agentEoa: ctx.agentEoa,
            subname: ctx.subname ?? null,
            pubkey: ctx.agentPubkey ?? null,
            iNFT: ctx.iNFT
              ? {
                  contract: ctx.iNFT.contract,
                  tokenId: ctx.iNFT.tokenId.toString(),
                }
              : null,
            network: ctx.network,
            singletons: ctx.singletons ?? null,
            brain: { provider: ctx.brainProvider ?? null, model: ctx.brainModel ?? null },
            wallet: {
              native: snap.native,
              tokens: snap.tokens.map(t => ({
                symbol: t.symbol,
                address: t.address,
                decimals: t.decimals,
                raw: t.raw,
                formatted: t.formatted,
              })),
              blockNumber: snap.blockNumber,
            },
            computeLedger0G: computeBalance,
            recentActivity: recent,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

interface ActivityEntry {
  ts: number
  kind: string
  summary: string
}

function readRecentActivity(agentDir: string, limit: number): ActivityEntry[] {
  const path = join(agentDir, 'activity.jsonl')
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter(Boolean)
  const tail = lines.slice(-limit)
  const out: ActivityEntry[] = []
  for (const line of tail) {
    try {
      const obj = JSON.parse(line) as { ts?: number; kind?: string; data?: unknown }
      if (typeof obj.ts === 'number' && typeof obj.kind === 'string') {
        out.push({
          ts: obj.ts,
          kind: obj.kind,
          summary: summarizeActivity(obj),
        })
      }
    } catch {
      // ignore malformed
    }
  }
  return out
}

function summarizeActivity(obj: { kind?: string; data?: unknown }): string {
  if (obj.kind === 'tool-call' && obj.data && typeof obj.data === 'object') {
    const data = obj.data as { call?: { name?: string } }
    return data.call?.name ?? 'tool'
  }
  if (typeof obj.kind === 'string') return obj.kind
  return 'event'
}
