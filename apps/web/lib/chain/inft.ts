// AnimaAgentNFT browser reader.

import type { Address, Hex, PublicClient } from 'viem'
import { keccak256, parseAbiItem, stringToBytes } from 'viem'
import { AGENT_NFT_ABI } from './abi'
import {
  ANIMA_AGENT_NFT_ADDRESS,
  ANIMA_FIRST_MINT_BLOCK,
  INTELLIGENT_DATA_SLOTS,
  type IntelligentDataSlot,
} from './chain'

export type SlotEntry = {
  name: IntelligentDataSlot
  hash: Hex
  isBootstrap: boolean
}

export type AgentSummary = {
  tokenId: bigint
  owner: Address
  slots: SlotEntry[]
  mintBlock: bigint
}

const mintedEvent = parseAbiItem(
  'event Minted(uint256 indexed tokenId, address indexed to, (string dataDescription, bytes32 dataHash)[] iDatas)',
)

const transferredEvent = parseAbiItem(
  'event Transferred(uint256 indexed tokenId, address indexed from, address indexed to)',
)

/**
 * Mark a slot's dataHash as the bootstrap placeholder, which the CLI writes
 * during anima init before the agent has produced any real memory.
 * Matches packages/core/src/identity/intelligent-data.ts:22.
 */
export function isBootstrapPlaceholder(hash: Hex, slot: IntelligentDataSlot): boolean {
  if (!hash || hash === '0x' || /^0x0+$/.test(hash)) return true
  const placeholder = keccak256(stringToBytes(`anima:bootstrap:${slot}`))
  return hash.toLowerCase() === placeholder.toLowerCase()
}

/**
 * Enumerate every iNFT minted to `owner`, then filter by current `ownerOf`.
 *
 * No multicall dependency. Uses two log scans (Minted to=owner, Transferred to=owner)
 * to find every tokenId that has ever been delivered to this address, then
 * checks current ownerOf to filter out tokens transferred away.
 */
export async function getAgentsByOwner(
  client: PublicClient,
  owner: Address,
): Promise<AgentSummary[]> {
  const fromBlock = ANIMA_FIRST_MINT_BLOCK

  const [mintedLogs, transferredLogs] = await Promise.all([
    client.getLogs({
      address: ANIMA_AGENT_NFT_ADDRESS,
      event: mintedEvent,
      args: { to: owner },
      fromBlock,
      toBlock: 'latest',
    }),
    client.getLogs({
      address: ANIMA_AGENT_NFT_ADDRESS,
      event: transferredEvent,
      args: { to: owner },
      fromBlock,
      toBlock: 'latest',
    }),
  ])

  // Track tokenId → earliest known block (for the mintBlock column).
  const tokenBlock = new Map<bigint, bigint>()
  for (const log of mintedLogs) {
    const tid = log.args.tokenId as bigint
    const blk = log.blockNumber ?? 0n
    const prior = tokenBlock.get(tid)
    if (prior === undefined || blk < prior) tokenBlock.set(tid, blk)
  }
  for (const log of transferredLogs) {
    const tid = log.args.tokenId as bigint
    if (!tokenBlock.has(tid)) tokenBlock.set(tid, log.blockNumber ?? 0n)
  }

  if (tokenBlock.size === 0) return []

  // Verify current ownership in parallel.
  const tokenIds = Array.from(tokenBlock.keys()).sort((a, b) => Number(a - b))
  const ownerChecks = await Promise.all(
    tokenIds.map(tid =>
      client
        .readContract({
          address: ANIMA_AGENT_NFT_ADDRESS,
          abi: AGENT_NFT_ABI,
          functionName: 'ownerOf',
          args: [tid],
        })
        .then(addr => ({ tid, addr: addr as Address }))
        .catch(() => null),
    ),
  )
  const ownedNow = ownerChecks
    .filter((r): r is { tid: bigint; addr: Address } => r !== null)
    .filter(r => r.addr.toLowerCase() === owner.toLowerCase())

  if (ownedNow.length === 0) return []

  // Fetch slot table for each.
  const summaries: AgentSummary[] = await Promise.all(
    ownedNow.map(async ({ tid, addr }) => {
      const slots = await fetchSlots(client, tid)
      return {
        tokenId: tid,
        owner: addr,
        slots,
        mintBlock: tokenBlock.get(tid) ?? 0n,
      }
    }),
  )

  return summaries.sort((a, b) => Number(a.tokenId - b.tokenId))
}

/**
 * Read the 6 IntelligentData slots for a tokenId. Returns canonical slot order.
 */
export async function fetchSlots(client: PublicClient, tokenId: bigint): Promise<SlotEntry[]> {
  const raw = (await client.readContract({
    address: ANIMA_AGENT_NFT_ADDRESS,
    abi: AGENT_NFT_ABI,
    functionName: 'getIntelligentData',
    args: [tokenId],
  })) as ReadonlyArray<{ dataDescription: string; dataHash: Hex }>

  return INTELLIGENT_DATA_SLOTS.map((name, idx): SlotEntry => {
    const entry = raw[idx]
    const hash = (entry?.dataHash ?? '0x') as Hex
    return {
      name,
      hash,
      isBootstrap: isBootstrapPlaceholder(hash, name),
    }
  })
}

export async function fetchOwner(client: PublicClient, tokenId: bigint): Promise<Address> {
  return (await client.readContract({
    address: ANIMA_AGENT_NFT_ADDRESS,
    abi: AGENT_NFT_ABI,
    functionName: 'ownerOf',
    args: [tokenId],
  })) as Address
}

/**
 * Recent Transferred events for a tokenId. Most-recent first, up to `limit`.
 */
export async function fetchTransferHistory(
  client: PublicClient,
  tokenId: bigint,
  limit = 10,
): Promise<{ from: Address; to: Address; blockNumber: bigint; txHash: Hex }[]> {
  const logs = await client.getLogs({
    address: ANIMA_AGENT_NFT_ADDRESS,
    event: transferredEvent,
    args: { tokenId },
    fromBlock: ANIMA_FIRST_MINT_BLOCK,
    toBlock: 'latest',
  })
  const sorted = logs
    .map(l => ({
      from: l.args.from as Address,
      to: l.args.to as Address,
      blockNumber: l.blockNumber ?? 0n,
      txHash: l.transactionHash as Hex,
    }))
    .sort((a, b) => Number(b.blockNumber - a.blockNumber))
  return sorted.slice(0, limit)
}

export type AgentChainMeta = {
  agentEoa: Address
  firstSyncAt: number // unix seconds, earliest Updated event block timestamp
  lastSyncAt: number // unix seconds, most recent Updated event block timestamp
  syncCount: number
}

/**
 * Scan Updated events on AnimaAgentNFT once, grouped by tokenId. For each
 * wanted tokenId we capture the first tx (whose sender is the agent EOA), the
 * earliest block (first sync timestamp), the latest block (most recent sync),
 * and the total event count. Resolves the tx senders + block timestamps in
 * parallel. Fresh agents (no Updated events) are absent from the result.
 */
export async function getAgentChainMetaByTokenId(
  client: PublicClient,
  tokenIds: bigint[],
): Promise<Map<bigint, AgentChainMeta>> {
  if (tokenIds.length === 0) return new Map()
  const event = parseAbiItem(
    'event Updated(uint256 indexed tokenId, uint256[] slots, bytes32[] newHashes)',
  )
  const logs = await client.getLogs({
    address: ANIMA_AGENT_NFT_ADDRESS,
    event,
    fromBlock: ANIMA_FIRST_MINT_BLOCK,
    toBlock: 'latest',
  })
  const wanted = new Set(tokenIds.map(t => t.toString()))
  type Probe = { firstTx?: Hex; firstBlock?: bigint; latestBlock?: bigint; count: number }
  const probes = new Map<string, Probe>()
  for (const log of logs) {
    const tid = (log.args.tokenId as bigint).toString()
    if (!wanted.has(tid)) continue
    const blk = log.blockNumber ?? 0n
    const probe = probes.get(tid) ?? { count: 0 }
    probe.count += 1
    if (!probe.firstBlock || blk < probe.firstBlock) {
      probe.firstBlock = blk
      if (log.transactionHash) probe.firstTx = log.transactionHash as Hex
    }
    if (!probe.latestBlock || blk > probe.latestBlock) probe.latestBlock = blk
    probes.set(tid, probe)
  }
  if (probes.size === 0) return new Map()
  const entries = await Promise.allSettled(
    Array.from(probes.entries()).map(async ([tid, probe]) => {
      if (!probe.firstTx || !probe.firstBlock || !probe.latestBlock) return null
      const [tx, firstBlock, lastBlock] = await Promise.all([
        client.getTransaction({ hash: probe.firstTx }),
        client.getBlock({ blockNumber: probe.firstBlock }),
        probe.firstBlock === probe.latestBlock
          ? client.getBlock({ blockNumber: probe.firstBlock })
          : client.getBlock({ blockNumber: probe.latestBlock }),
      ])
      return [
        BigInt(tid),
        {
          agentEoa: tx.from as Address,
          firstSyncAt: Number(firstBlock.timestamp),
          lastSyncAt: Number(lastBlock.timestamp),
          syncCount: probe.count,
        },
      ] as const
    }),
  )
  const out = new Map<bigint, AgentChainMeta>()
  for (const r of entries) {
    if (r.status === 'fulfilled' && r.value) {
      const [tid, meta] = r.value
      out.set(tid, meta)
    }
  }
  return out
}

/**
 * Updated events for a tokenId (data anchor updates). Most-recent first.
 */
export async function fetchAnchorHistory(
  client: PublicClient,
  tokenId: bigint,
  limit = 10,
): Promise<{ slots: bigint[]; newHashes: Hex[]; blockNumber: bigint; txHash: Hex }[]> {
  const event = parseAbiItem(
    'event Updated(uint256 indexed tokenId, uint256[] slots, bytes32[] newHashes)',
  )
  const logs = await client.getLogs({
    address: ANIMA_AGENT_NFT_ADDRESS,
    event,
    args: { tokenId },
    fromBlock: ANIMA_FIRST_MINT_BLOCK,
    toBlock: 'latest',
  })
  const sorted = logs
    .map(l => ({
      slots: (l.args.slots ?? []) as bigint[],
      newHashes: (l.args.newHashes ?? []) as Hex[],
      blockNumber: l.blockNumber ?? 0n,
      txHash: l.transactionHash as Hex,
    }))
    .sort((a, b) => Number(b.blockNumber - a.blockNumber))
  return sorted.slice(0, limit)
}
