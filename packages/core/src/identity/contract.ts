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
import { getGasPriceWithFloor, makeViemClients, ogChain } from '../chain'
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
    // Explicit `gas` because some WC wallets (MetaMask Mobile in particular)
    // ignore viem's `eth_estimateGas` result and substitute their own much
    // smaller estimate, which OOGs the mint mid-execution. 800k covers a
    // 6-slot mint with comfortable headroom (actual usage ~300-400k).
    // `gasPrice` is read live so we follow the network's current floor
    // instead of relying on a stale hardcode.
    const gasPrice = await getGasPriceWithFloor(this.publicClient)
    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: AGENT_NFT_ABI,
      functionName: 'mint',
      args: [params.to, params.iDatas],
      chain: this.chain,
      account: this.account,
      gas: 800_000n,
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice,
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
    // Per-slot anchor costs ~30-50k gas. Cap at 600k for up to 6 slots with
    // headroom; matches the explicit-gas pattern from `mint` so WC wallets
    // that auto-substitute gas don't OOG.
    const gas = BigInt(updates.length) * 100_000n + 200_000n
    const gasPrice = await getGasPriceWithFloor(this.publicClient)
    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: AGENT_NFT_ABI,
      functionName: 'update',
      args: [tokenId, slots, hashes],
      chain: this.chain,
      account: this.account,
      gas,
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice,
    })
    const receipt = await waitForReceiptResilient(this.publicClient, hash)
    if (receipt.status !== 'success') {
      throw new Error(`update reverted in tx ${hash}`)
    }
    return hash
  }

  /**
   * ERC-7857 intelligent transfer: rewrites all 6 IntelligentData slot hashes
   * AND moves ownership in a single atomic tx, gated by an oracle ECDSA proof.
   *
   * The `oracleSignature` must be produced by signing the proof preimage with
   * the address returned by `teeOracle()` on the contract. Use
   * `signTransferProof` from `./transfer` to build it.
   *
   * Caller (the wallet behind this client) must be either the `from` address,
   * a per-token approved operator, or `setApprovalForAll(from, caller)`.
   * In the standard transfer flow, the `from` operator's wallet IS this client.
   */
  async iTransferFrom(args: {
    from: Address
    to: Address
    tokenId: bigint
    newHashes: readonly Hex[]
    proofNonce: Hex
    oracleSignature: Hex
  }): Promise<Hex> {
    if (args.newHashes.length === 0) {
      throw new Error('iTransferFrom: newHashes empty')
    }
    // Atomic 6-slot rewrite + ECDSA recover + transfer; ~250-400k gas in
    // practice. Same explicit-gas pattern as mint/update for WC compatibility.
    const gas = BigInt(args.newHashes.length) * 60_000n + 200_000n
    const gasPrice = await getGasPriceWithFloor(this.publicClient)
    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: AGENT_NFT_ABI,
      functionName: 'iTransferFrom',
      args: [
        args.from,
        args.to,
        args.tokenId,
        [...args.newHashes],
        args.proofNonce,
        args.oracleSignature,
      ],
      chain: this.chain,
      account: this.account,
      gas,
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice,
    })
    const receipt = await waitForReceiptResilient(this.publicClient, hash)
    if (receipt.status !== 'success') {
      throw new Error(`iTransferFrom reverted in tx ${hash}`)
    }
    return hash
  }

  /**
   * Read the address authorized to sign transfer proofs (`teeOracle()` on the
   * contract). Used by `anima transfer` to detect whether the operator wallet
   * IS the oracle (MVP path) or a separate signer is required.
   */
  async teeOracle(): Promise<Address> {
    return (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: AGENT_NFT_ABI,
      functionName: 'teeOracle',
    })) as Address
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
