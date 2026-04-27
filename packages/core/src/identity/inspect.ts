import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  keccak256,
} from 'viem'
import type { AnimaNetwork } from '../config'
import { NETWORK_RPC } from '../config'
import { decryptMemoryBytes } from '../memory/encryption'
import { readOrNull } from '../memory/fs-util'
import { downloadBlobByRoot } from '../storage/og'
import { AGENT_NFT_ABI } from './abi'
import { AnimaAgentNFTReader, bootstrapHashFor } from './contract'
import { INTELLIGENT_DATA_SLOTS, type IntelligentDataSlot, slotByIndex } from './intelligent-data'

/**
 * Phase 9.1 `anima inspect` library.
 *
 * Pure read-only audit of an iNFT's IntelligentData slots. Pulls slot hashes
 * off chain, fetches each encrypted blob from 0G Storage, optionally
 * decrypts, returns a structured result the CLI (or any caller) can render.
 *
 * No funds, no private state. Safe to call against ANY iNFT, including ones
 * the caller does not own — the encrypted blobs leak only their byte size
 * to anyone without the operator wallet.
 */

export type DecryptStatus =
  /** Slot decoded and decrypted to plaintext. */
  | 'ok'
  /** No memory key supplied; ciphertext only. */
  | 'no-key'
  /** Slot is the operator-encrypted keystore; not memory-key decryptable. */
  | 'keystore-skipped'
  /** Decryption threw (wrong key, corrupt blob, version mismatch). */
  | 'decrypt-failed'
  /** Slot still holds the bootstrap placeholder; nothing to fetch. */
  | 'empty'
  /** Storage fetch failed (indexer + discovered-nodes both came up empty). */
  | 'fetch-failed'

export interface SlotInspection {
  slot: IntelligentDataSlot
  rootHash: Hex
  /** True when rootHash equals `bootstrapHashFor(slot)` (slot never anchored). */
  empty: boolean
  /** Raw ciphertext bytes from 0G Storage. null on fetch failure or empty slot. */
  ciphertext: Uint8Array | null
  /** Plaintext bytes after decrypt. null when status !== 'ok'. */
  plaintext: Uint8Array | null
  /** keccak256 of plaintext bytes. null when no plaintext. */
  plaintextHash: Hex | null
  decryptStatus: DecryptStatus
  decryptError?: string
  fetchError?: string
}

export interface InspectAgentOpts {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  /** Memory key (HKDF-derived from agent privkey via `deriveMemoryKey`). */
  memoryKey?: Buffer
  /** Filter to specific slots. Defaults to all six. */
  slots?: IntelligentDataSlot[]
}

export interface InspectAgentResult {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  owner: Address
  slots: SlotInspection[]
}

/** Fetch + (optionally) decrypt one slot. Pure read; no funds required. */
export async function inspectSlot(opts: {
  network: AnimaNetwork
  slot: IntelligentDataSlot
  rootHash: Hex
  memoryKey?: Buffer
}): Promise<SlotInspection> {
  const { network, slot, rootHash, memoryKey } = opts

  if (rootHash === bootstrapHashFor(slot)) {
    return {
      slot,
      rootHash,
      empty: true,
      ciphertext: null,
      plaintext: null,
      plaintextHash: null,
      decryptStatus: 'empty',
    }
  }

  let ciphertext: Uint8Array | null = null
  let fetchError: string | undefined
  try {
    ciphertext = await downloadBlobByRoot(network, rootHash)
    if (!ciphertext) {
      fetchError = 'blob fetch returned null (indexer + discovered-nodes both failed)'
    }
  } catch (e) {
    fetchError = (e as Error).message
  }

  if (!ciphertext) {
    return {
      slot,
      rootHash,
      empty: false,
      ciphertext: null,
      plaintext: null,
      plaintextHash: null,
      decryptStatus: 'fetch-failed',
      fetchError,
    }
  }

  // Keystore is encrypted to the operator's wallet via sign-derived-key, not
  // to the memory key. Caller decrypts via `fetchAndDecryptKeystore` if they
  // want plaintext; here we surface the bytes only.
  if (slot === 'keystore') {
    return {
      slot,
      rootHash,
      empty: false,
      ciphertext,
      plaintext: null,
      plaintextHash: null,
      decryptStatus: 'keystore-skipped',
    }
  }

  if (!memoryKey) {
    return {
      slot,
      rootHash,
      empty: false,
      ciphertext,
      plaintext: null,
      plaintextHash: null,
      decryptStatus: 'no-key',
    }
  }

  try {
    const plaintext = decryptMemoryBytes(ciphertext, memoryKey)
    return {
      slot,
      rootHash,
      empty: false,
      ciphertext,
      plaintext,
      plaintextHash: keccak256(plaintext),
      decryptStatus: 'ok',
    }
  } catch (e) {
    return {
      slot,
      rootHash,
      empty: false,
      ciphertext,
      plaintext: null,
      plaintextHash: null,
      decryptStatus: 'decrypt-failed',
      decryptError: (e as Error).message,
    }
  }
}

/** Fetch + (optionally) decrypt every IntelligentData slot in parallel. */
export async function inspectAgent(opts: InspectAgentOpts): Promise<InspectAgentResult> {
  const reader = new AnimaAgentNFTReader({
    network: opts.network,
    contractAddress: opts.contractAddress,
  })
  const [data, owner] = await Promise.all([
    reader.getIntelligentData(opts.tokenId),
    reader.ownerOf(opts.tokenId),
  ])
  const slotMap = new Map<IntelligentDataSlot, Hex>()
  for (const e of data) slotMap.set(e.dataDescription, e.dataHash)

  const slotFilter = opts.slots ? new Set<IntelligentDataSlot>(opts.slots) : null
  const targets = INTELLIGENT_DATA_SLOTS.filter(s => !slotFilter || slotFilter.has(s))

  const results = await Promise.all(
    targets.map(slot =>
      inspectSlot({
        network: opts.network,
        slot,
        rootHash: slotMap.get(slot) ?? bootstrapHashFor(slot),
        memoryKey: opts.memoryKey,
      }),
    ),
  )

  return {
    network: opts.network,
    contractAddress: opts.contractAddress,
    tokenId: opts.tokenId,
    owner,
    slots: results,
  }
}

export interface SlotDiff {
  slot: IntelligentDataSlot
  /** Local file bytes; null when file missing. */
  local: Uint8Array | null
  /** Decrypted chain bytes; null when chain slot empty or decrypt failed. */
  chain: Uint8Array | null
  /** keccak256 of local bytes. */
  localHash: Hex | null
  /** keccak256 of chain plaintext. */
  chainHash: Hex | null
  /** Chain side root hash (the merkle root of the encrypted blob). */
  chainRootHash: Hex
  status: 'in-sync' | 'differ' | 'local-only' | 'chain-only' | 'both-missing' | 'cannot-decrypt'
  /** Error from chain-side decrypt or fetch. */
  chainError?: string
}

export interface DiffAgentOpts {
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  memoryKey: Buffer
  /** Local file paths keyed by slot. Slots not present skip the local side. */
  localPaths: Partial<Record<IntelligentDataSlot, string>>
}

/**
 * Compare local memory files against the chain-anchored encrypted plaintext.
 * Surfaces drift between what's on disk and what's actually on chain — useful
 * before transfers, after a `git pull`, or to spot stale local state.
 *
 * Keystore + activity-log are intentionally excluded from caller's `localPaths`
 * by design: keystore needs operator-wallet decrypt (separate code path),
 * activity-log churns per-turn so a content diff is uninformative.
 */
export async function diffAgent(opts: DiffAgentOpts): Promise<SlotDiff[]> {
  const inspected = await inspectAgent({
    network: opts.network,
    contractAddress: opts.contractAddress,
    tokenId: opts.tokenId,
    memoryKey: opts.memoryKey,
  })
  const out: SlotDiff[] = []
  for (const inspection of inspected.slots) {
    if (inspection.slot === 'keystore') continue
    const localPath = opts.localPaths[inspection.slot]
    const local = localPath ? await readOrNull(localPath) : null
    const localHash = local ? keccak256(local) : null
    const chain = inspection.plaintext
    const chainHash = inspection.plaintextHash
    let status: SlotDiff['status']
    let chainError: string | undefined
    if (
      inspection.decryptStatus === 'decrypt-failed' ||
      inspection.decryptStatus === 'fetch-failed'
    ) {
      status = 'cannot-decrypt'
      chainError = inspection.decryptError ?? inspection.fetchError
    } else if (!local && !chain) {
      status = 'both-missing'
    } else if (!local) {
      status = 'chain-only'
    } else if (!chain) {
      status = 'local-only'
    } else if (localHash === chainHash) {
      status = 'in-sync'
    } else {
      status = 'differ'
    }
    out.push({
      slot: inspection.slot,
      local,
      chain,
      localHash,
      chainHash,
      chainRootHash: inspection.rootHash,
      status,
      chainError,
    })
  }
  return out
}

export interface TxInspection {
  txHash: Hex
  blockNumber: bigint
  blockHash: Hex
  /** Token affected (parsed from calldata or the Updated event). */
  tokenId: bigint
  /** Slots touched in this tx, in calldata order. */
  slots: IntelligentDataSlot[]
  /** Hashes anchored at this tx, parallel to `slots`. */
  hashesAtTx: Hex[]
  /** Current chain state for these slots; each entry's `current` may differ from `hashesAtTx[i]` if a later tx superseded. */
  current: Map<IntelligentDataSlot, Hex>
}

/**
 * Decode the calldata + receipt logs of an iNFT `update` tx.
 *
 * Reports which slots were anchored, the hashes anchored at that tx, AND the
 * current on-chain hash so the caller can see whether subsequent txs have
 * superseded the targeted slots.
 */
export async function inspectTx(opts: {
  network: AnimaNetwork
  contractAddress: Address
  txHash: Hex
}): Promise<TxInspection> {
  const client = createPublicClient({ transport: http(NETWORK_RPC[opts.network]) })
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: opts.txHash }),
    client.getTransactionReceipt({ hash: opts.txHash }),
  ])
  if (tx.to?.toLowerCase() !== opts.contractAddress.toLowerCase()) {
    throw new Error(
      `tx ${opts.txHash} was sent to ${tx.to}, not the iNFT at ${opts.contractAddress}`,
    )
  }

  let tokenId: bigint
  let slotIndices: bigint[]
  let hashes: Hex[]

  // Prefer event logs (cheaper to validate; topic-indexed by tokenId), fall back to calldata decode.
  const updatedEvents = receipt.logs
    .filter(l => l.address.toLowerCase() === opts.contractAddress.toLowerCase())
    .map(l => {
      try {
        return decodeEventLog({
          abi: AGENT_NFT_ABI,
          data: l.data,
          topics: l.topics,
          eventName: 'Updated',
        })
      } catch {
        return null
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)

  if (updatedEvents.length > 0) {
    const ev = updatedEvents[0]!
    tokenId = ev.args.tokenId
    slotIndices = [...ev.args.slots]
    hashes = [...ev.args.newHashes]
  } else {
    const decoded = decodeFunctionData({ abi: AGENT_NFT_ABI, data: tx.input })
    if (decoded.functionName !== 'update') {
      throw new Error(
        `tx ${opts.txHash} called \`${decoded.functionName}\`, not \`update\` — nothing to inspect`,
      )
    }
    const [decTokenId, decSlots, decHashes] = decoded.args as [
      bigint,
      readonly bigint[],
      readonly Hex[],
    ]
    tokenId = decTokenId
    slotIndices = [...decSlots]
    hashes = [...decHashes]
  }

  const slots = slotIndices.map(idx => slotByIndex(Number(idx)))
  const reader = new AnimaAgentNFTReader({
    network: opts.network,
    contractAddress: opts.contractAddress,
  })
  const currentHashes = await Promise.all(slots.map(slot => reader.getSlotHash(tokenId, slot)))
  const current = new Map<IntelligentDataSlot, Hex>()
  for (let i = 0; i < slots.length; i++) current.set(slots[i]!, currentHashes[i]!)

  return {
    txHash: opts.txHash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    tokenId,
    slots,
    hashesAtTx: hashes,
    current,
  }
}
