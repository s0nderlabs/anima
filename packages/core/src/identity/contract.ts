import {
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  keccak256,
  parseEventLogs,
  toBytes,
} from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { MIN_GAS_PRICE, makeViemClients, ogChain } from '../chain'
import { type AnimaNetwork, NETWORK_RPC } from '../config'
import { AGENT_NFT_ABI } from './abi'
import {
  INTELLIGENT_DATA_SLOTS,
  type IntelligentDataEntry,
  type IntelligentDataSlot,
  type MintParams,
  type MintResult,
  type UpdateSlot,
  slotIndex,
} from './intelligent-data'
import { waitForReceiptResilient } from './receipt'

export interface ClientConfig {
  network: AnimaNetwork
  contractAddress: Address
  privkeyHex: Hex
}

export interface ReaderConfig {
  network: AnimaNetwork
  contractAddress: Address
}

/**
 * Read-only view into an AnimaAgentNFT deployment. No wallet required.
 * Used by `anima restore`, subname availability checks, and other flows
 * that only need `getIntelligentData` / `ownerOf` / `getSlotHash`.
 */
export class AnimaAgentNFTReader {
  readonly publicClient: PublicClient
  readonly contractAddress: Address

  constructor(cfg: ReaderConfig) {
    const chain = ogChain(cfg.network)
    this.publicClient = createPublicClient({
      transport: http(NETWORK_RPC[cfg.network]),
      chain,
    })
    this.contractAddress = cfg.contractAddress
  }

  async totalSupply(): Promise<bigint> {
    return await this.publicClient.readContract({
      address: this.contractAddress,
      abi: AGENT_NFT_ABI,
      functionName: 'totalSupply',
    })
  }

  async ownerOf(tokenId: bigint): Promise<Address> {
    return (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: AGENT_NFT_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    })) as Address
  }

  async getIntelligentData(tokenId: bigint): Promise<IntelligentDataEntry[]> {
    const data = (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: AGENT_NFT_ABI,
      functionName: 'getIntelligentData',
      args: [tokenId],
    })) as readonly { dataDescription: string; dataHash: Hex }[]
    return data.map(d => ({
      dataDescription: d.dataDescription as IntelligentDataSlot,
      dataHash: d.dataHash,
    }))
  }

  async getSlotHash(tokenId: bigint, slot: IntelligentDataSlot): Promise<Hex> {
    return (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: AGENT_NFT_ABI,
      functionName: 'getSlotHash',
      args: [tokenId, BigInt(slotIndex(slot))],
    })) as Hex
  }
}

export class AnimaAgentNFTClient extends AnimaAgentNFTReader {
  readonly walletClient: WalletClient
  readonly account: PrivateKeyAccount
  private readonly chain: Chain

  constructor(cfg: ClientConfig) {
    super(cfg)
    const clients = makeViemClients({ network: cfg.network, privkeyHex: cfg.privkeyHex })
    this.account = clients.account
    this.chain = clients.chain
    this.walletClient = clients.walletClient
  }

  async mint(params: MintParams): Promise<MintResult> {
    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: AGENT_NFT_ABI,
      functionName: 'mint',
      args: [params.to, params.iDatas],
      chain: this.chain,
      account: this.account,
      maxFeePerGas: MIN_GAS_PRICE,
      maxPriorityFeePerGas: MIN_GAS_PRICE,
    })
    const receipt = await waitForReceiptResilient(this.publicClient, hash)
    if (receipt.status !== 'success') {
      throw new Error(`mint reverted in tx ${hash}`)
    }
    const logs = parseEventLogs({
      abi: AGENT_NFT_ABI,
      eventName: 'Minted',
      logs: receipt.logs,
    })
    const first = logs[0]
    if (!first) throw new Error('mint succeeded but Minted event missing')
    const tokenId = first.args.tokenId as bigint
    return { tokenId, txHash: hash, blockNumber: receipt.blockNumber }
  }

  async updateSlots(tokenId: bigint, updates: UpdateSlot[]): Promise<Hex> {
    if (updates.length === 0) throw new Error('updateSlots: empty updates')
    const slots = updates.map(u => BigInt(slotIndex(u.slot)))
    const hashes = updates.map(u => u.dataHash)
    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: AGENT_NFT_ABI,
      functionName: 'update',
      args: [tokenId, slots, hashes],
      chain: this.chain,
      account: this.account,
      maxFeePerGas: MIN_GAS_PRICE,
      maxPriorityFeePerGas: MIN_GAS_PRICE,
    })
    const receipt = await waitForReceiptResilient(this.publicClient, hash)
    if (receipt.status !== 'success') {
      throw new Error(`update reverted in tx ${hash}`)
    }
    return hash
  }
}

/** Build the 6 canonical IntelligentData entries from optional per-slot real hashes. */
export function buildMintEntries(
  realHashes: Partial<Record<IntelligentDataSlot, Hex>>,
): IntelligentDataEntry[] {
  return INTELLIGENT_DATA_SLOTS.map(slot => ({
    dataDescription: slot,
    dataHash: realHashes[slot] ?? bootstrapHashFor(slot),
  }))
}

export function bootstrapHashFor(slot: IntelligentDataSlot): Hex {
  return keccak256(toBytes(`anima:bootstrap:${slot}`))
}
