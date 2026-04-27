import { type Address, type Hex, keccak256, parseEventLogs } from 'viem'
import { getGasPriceWithFloor } from '../chain'
import type { OperatorSigner } from '../operator'
import { agentPaths } from '../paths'
import { AGENT_NFT_ABI } from './abi'
import { bootstrapHashFor, buildMintEntries } from './contract'
import { ANIMA_AGENT_NFT_ADDRESS, type NetworkName } from './deployments'
import type { IntelligentDataEntry, MintResult } from './intelligent-data'
import { waitForReceiptResilient } from './receipt'

export interface MintAgentOpts {
  network: NetworkName
  /**
   * Operator signs the mint tx + owns the iNFT (section 22.1 wallet model).
   * Agent EOA is a separate infra key — see `agentAddress` below.
   */
  operator: OperatorSigner
  /**
   * Agent EOA address. Operator will `setApprovalForAll(agentAddress, true)`
   * inside this function so the agent can later call `update()` without
   * holding the operator's key.
   */
  agentAddress: Address
  /**
   * Optional bytes32 to set in the keystore IntelligentData slot at mint time.
   * Phase 6.6 mints with `bootstrapHashFor('keystore')` and lets the agent
   * push the real 0G Storage root hash via `update()` after the encrypted
   * blob is uploaded. Pass an explicit hash here only if the upload happens
   * pre-mint (e.g. cold-start sandbox flow).
   */
  keystoreRootHash?: Hex
}

export async function mintAgent(opts: MintAgentOpts): Promise<{
  result: MintResult
  entries: IntelligentDataEntry[]
  contractAddress: Address
  operatorAddress: Address
}> {
  const contractAddress = ANIMA_AGENT_NFT_ADDRESS[opts.network]
  const keystoreHash = opts.keystoreRootHash ?? (bootstrapHashFor('keystore') as Hex)
  const entries = buildMintEntries({ keystore: keystoreHash })

  const operatorAddress = await opts.operator.address()
  const walletClient = await opts.operator.walletClient(opts.network)
  const publicClient = await opts.operator.publicClient(opts.network)
  const chain = opts.operator.chain(opts.network)

  // One gas-price read covers both writes; mint and approval fire back-to-back
  // and the network floor cannot move meaningfully between them.
  const gasPrice = await getGasPriceWithFloor(publicClient)
  // walletClient already has the operator account set as default (json-rpc for
  // WalletConnect, LocalAccount for privkey-based sources). Passing it through
  // explicitly so viem doesn't fall through to its no-account path. Do NOT
  // call operator.account() and pass that here for WC: it returns a
  // LocalAccount whose signTransaction routes to eth_signTransaction, which
  // MM Mobile rejects with -32004.
  if (!walletClient.account) throw new Error('walletClient is missing default account')
  const mintHash = await walletClient.writeContract({
    address: contractAddress,
    abi: AGENT_NFT_ABI,
    functionName: 'mint',
    args: [operatorAddress, entries],
    chain,
    account: walletClient.account,
    gas: 800_000n,
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: gasPrice,
  })
  const mintReceipt = await waitForReceiptResilient(publicClient, mintHash)
  if (mintReceipt.status !== 'success') throw new Error(`mint reverted in tx ${mintHash}`)
  const logs = parseEventLogs({
    abi: AGENT_NFT_ABI,
    eventName: 'Minted',
    logs: mintReceipt.logs,
  })
  const first = logs[0]
  if (!first) throw new Error('mint succeeded but Minted event missing')
  const tokenId = first.args.tokenId as bigint

  // Operator pre-approves the agent EOA so the agent can push memory updates
  // without the operator's key. Matches section 22.1 two-wallet architecture.
  const approvalHash = await walletClient.writeContract({
    address: contractAddress,
    abi: AGENT_NFT_ABI,
    functionName: 'setApprovalForAll',
    args: [opts.agentAddress, true],
    chain,
    account: walletClient.account,
    gas: 200_000n,
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: gasPrice,
  })
  await waitForReceiptResilient(publicClient, approvalHash)

  return {
    result: { tokenId, txHash: mintHash, blockNumber: mintReceipt.blockNumber },
    entries,
    contractAddress,
    operatorAddress,
  }
}

export interface DerivedAgentIdOpts {
  contractAddress: string
  tokenId: bigint
}

/**
 * Derive the per-agent id used for the on-disk agent state directory.
 * Post-mint agents key off (contract, tokenId) hash; pre-mint agents fall back
 * to `placeholderAgentId(eoaAddress)` so runtime has something stable either way.
 */
export function iNFTAgentId(opts: DerivedAgentIdOpts): string {
  const packed = `${opts.contractAddress.toLowerCase()}:${opts.tokenId.toString()}`
  return keccak256(new TextEncoder().encode(packed)).slice(2, 18)
}

export { agentPaths }
export { bootstrapHashFor }
