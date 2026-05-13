import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import type { Address, Hex } from 'viem'
import { z } from 'zod'
import type { AnimaNetwork } from '../config'
import { AnimaAgentNFTReader, type IntelligentDataEntry, bootstrapHashFor } from '../identity'
import { agentPaths } from '../paths'
import type { ToolDef } from '../tools/types'

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'

/**
 * `memory.list` — enumerate every memory file the agent has stored locally
 * plus the 6 on-chain iNFT slot statuses.
 *
 * Returns three sections:
 *   - `agent[]`: files under `memory/agent/` (identity, persona, learned-*)
 *   - `user[]`: files under `memory/user/` (feedback, project, reference, profile)
 *   - `slots[]`: 6 iNFT slot dataHash + dataDescription + status (initialized/bootstrap/zero)
 *
 * Use when the operator asks to enumerate what the agent knows. `memory.read`
 * fetches individual file bodies; this tool just lists what's available.
 */
const listSchema = z.object({})

export type MemoryListArgs = z.infer<typeof listSchema>

export interface MemoryListAgentFile {
  file: string
  title: string
  description: string | null
  bytes: number
}

export interface MemoryListSlotEntry {
  slot: string
  dataDescription: string
  dataHash: Hex
  status: 'initialized' | 'bootstrap' | 'zero'
}

export interface MakeMemoryListToolArgs {
  agentId: string
  agentDir?: string
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  /** Test-injection point. Production passes a real `AnimaAgentNFTReader.getIntelligentData` binding. */
  fetchSlots?: () => Promise<IntelligentDataEntry[]>
}

export function makeMemoryListTool(opts: MakeMemoryListToolArgs): ToolDef<MemoryListArgs> {
  const fetchSlots = opts.fetchSlots ?? defaultFetchSlots(opts)
  const memDir = opts.agentDir
    ? join(opts.agentDir, 'memory')
    : agentPaths.agent(opts.agentId).memoryDir
  return {
    name: 'memory.list',
    description:
      "Enumerate every memory file (agent + user partitions) AND the 6 on-chain iNFT slot statuses. Call when the operator asks 'show me all your memory' / 'what do you remember' / 'list everything you have stored'. Returns three sections: agent (identity, persona, learned-*), user (feedback, project, reference, profile), and slots (memory-index, identity, persona, profile, keystore, activity-log).",
    schema: listSchema,
    handler: async () => {
      const [agentFiles, userFiles, slots] = await Promise.all([
        listPartition(memDir, 'agent'),
        listPartition(memDir, 'user'),
        listSlots(fetchSlots),
      ])
      return {
        ok: true,
        data: {
          agent: agentFiles,
          user: userFiles,
          slots,
        },
      }
    },
  }
}

async function listPartition(
  memDir: string,
  partition: 'agent' | 'user',
): Promise<MemoryListAgentFile[]> {
  const dir = join(memDir, partition)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const results = await Promise.all(
    names
      .filter(n => n.endsWith('.md'))
      .map(async name => {
        const filePath = join(dir, name)
        try {
          const [statResult, content] = await Promise.all([
            stat(filePath),
            readFile(filePath, 'utf8'),
          ])
          if (!statResult.isFile()) return null
          // gray-matter on first 4KB is enough for frontmatter parse.
          const head = content.length > 4096 ? content.slice(0, 4096) : content
          let title = name.replace(/\.md$/, '')
          let description: string | null = null
          try {
            const parsed = matter(head)
            const fm = parsed.data as { name?: string; description?: string }
            if (fm.name && typeof fm.name === 'string') title = fm.name
            if (fm.description && typeof fm.description === 'string') description = fm.description
          } catch {
            // Bad frontmatter — fall back to filename.
          }
          return {
            file: `${partition}/${name}`,
            title,
            description,
            bytes: statResult.size,
          } satisfies MemoryListAgentFile
        } catch {
          return null
        }
      }),
  )
  return results.filter((r): r is MemoryListAgentFile => r !== null)
}

async function listSlots(
  fetchSlots: () => Promise<IntelligentDataEntry[]>,
): Promise<MemoryListSlotEntry[]> {
  let entries: IntelligentDataEntry[]
  try {
    entries = await fetchSlots()
  } catch {
    return []
  }
  return entries.map(entry => {
    let status: MemoryListSlotEntry['status'] = 'initialized'
    if (entry.dataHash === ZERO_HASH) status = 'zero'
    else if (entry.dataHash === bootstrapHashFor(entry.dataDescription)) status = 'bootstrap'
    return {
      slot: entry.dataDescription,
      dataDescription: entry.dataDescription,
      dataHash: entry.dataHash,
      status,
    }
  })
}

function defaultFetchSlots(opts: MakeMemoryListToolArgs): () => Promise<IntelligentDataEntry[]> {
  return async () => {
    const reader = new AnimaAgentNFTReader({
      network: opts.network,
      contractAddress: opts.contractAddress,
    })
    return reader.getIntelligentData(opts.tokenId)
  }
}
