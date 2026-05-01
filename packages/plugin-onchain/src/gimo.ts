/**
 * Gimo liquid-staking pool client. Verified on mainnet May 1 2026:
 *
 *   - stake(string referrer)   payable, mints stOG.  Selector 0x46f45b8d.
 *                              Min 0.01 0G; below reverts with 0x41524be2.
 *   - unstake(uint256 amount)  burns stOG, queues withdrawal. Selector 0x2e17de78.
 *   - withdraw()               claims queued. Selector 0x3ccfd60b. Reverts
 *                              with 0xd6d9e665 if cooldown not elapsed.
 *   - stOG.getRate()           1.281648 0G per stOG (1e18 fixed-point).
 */

import { getGasPriceWithFloor } from '@s0nderlabs/anima-core'
import { type Address, type PublicClient, type WalletClient, pad, parseEventLogs } from 'viem'
import { GIMO_POOL_ABI, STOG_ABI } from './abis'
import {
  GIMO_BY_NETWORK,
  GIMO_COOLDOWN_REVERT_SELECTOR,
  GIMO_COOLDOWN_SECS,
  GIMO_MIN_STAKE_REVERT_SELECTOR,
  LOG_SCAN_CHUNK_BLOCKS,
  LOG_SCAN_MAX_CHUNKS,
  MIN_STAKE_WEI,
} from './constants'
import { rawGetLogs } from './raw-logs'
import { waitForReceipt } from './wait-receipt'

export class StakeBelowMinError extends Error {
  constructor(amount: bigint) {
    super(`stake amount ${amount} is below Gimo's minimum (${MIN_STAKE_WEI} wei = 0.01 0G)`)
  }
}

export class CooldownNotElapsedError extends Error {
  constructor(public etaSeconds: number) {
    super(`Gimo withdrawal cooldown not elapsed; ~${Math.round(etaSeconds / 3600)}h remaining`)
  }
}

function gimo(network: '0g-mainnet') {
  const a = GIMO_BY_NETWORK[network]
  if (!a) throw new Error(`Gimo not deployed on ${network}`)
  return a
}

export async function stakeNative(opts: {
  publicClient: PublicClient
  walletClient: WalletClient
  network: '0g-mainnet'
  amountWei: bigint
}): Promise<{
  txHash: `0x${string}`
  blockNumber: number
  stogMinted: bigint
  gasUsed: bigint
}> {
  const { publicClient, walletClient, network, amountWei } = opts
  if (amountWei < MIN_STAKE_WEI) throw new StakeBelowMinError(amountWei)
  const account = walletClient.account
  if (!account) throw new Error('walletClient has no account; cannot stake')
  const gasPrice = await getGasPriceWithFloor(publicClient)
  const txHash = await walletClient.writeContract({
    address: gimo(network).pool as Address,
    abi: GIMO_POOL_ABI,
    functionName: 'stake',
    args: [''],
    value: amountWei,
    chain: walletClient.chain,
    account,
    gasPrice,
  })
  const receipt = await waitForReceipt(publicClient, txHash)
  // Decode Staked event for stogMinted
  let stogMinted = 0n
  try {
    const logs = parseEventLogs({
      abi: GIMO_POOL_ABI,
      eventName: 'Staked',
      logs: receipt.logs,
    }) as Array<{ args: { stogMinted?: bigint; amount0g?: bigint } }>
    if (logs[0]?.args?.stogMinted) stogMinted = logs[0].args.stogMinted
  } catch {
    // Without the event, we'll have to read stOG balance delta — caller can do that
  }
  return {
    txHash,
    blockNumber: Number(receipt.blockNumber),
    stogMinted,
    gasUsed: receipt.gasUsed,
  }
}

export async function unstakeStog(opts: {
  publicClient: PublicClient
  walletClient: WalletClient
  network: '0g-mainnet'
  amountStog: bigint
}): Promise<{
  txHash: `0x${string}`
  blockNumber: number
  queuedAt: number
  estimatedClaimAt: number
  gasUsed: bigint
}> {
  const { publicClient, walletClient, network, amountStog } = opts
  const account = walletClient.account
  if (!account) throw new Error('walletClient has no account; cannot unstake')
  const gasPrice = await getGasPriceWithFloor(publicClient)
  const txHash = await walletClient.writeContract({
    address: gimo(network).pool as Address,
    abi: GIMO_POOL_ABI,
    functionName: 'unstake',
    args: [amountStog],
    chain: walletClient.chain,
    account,
    gasPrice,
  })
  const receipt = await waitForReceipt(publicClient, txHash)
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
  const queuedAt = Number(block.timestamp)
  return {
    txHash,
    blockNumber: Number(receipt.blockNumber),
    queuedAt,
    estimatedClaimAt: queuedAt + Number(GIMO_COOLDOWN_SECS),
    gasUsed: receipt.gasUsed,
  }
}

/**
 * Claim queued withdrawal. Decodes the cooldown revert into a friendly error.
 */
export async function claimWithdrawal(opts: {
  publicClient: PublicClient
  walletClient: WalletClient
  network: '0g-mainnet'
}): Promise<{ txHash: `0x${string}`; blockNumber: number; gasUsed: bigint }> {
  const { publicClient, walletClient, network } = opts
  const account = walletClient.account
  if (!account) throw new Error('walletClient has no account; cannot claim')
  const gasPrice = await getGasPriceWithFloor(publicClient)
  try {
    const txHash = await walletClient.writeContract({
      address: gimo(network).pool as Address,
      abi: GIMO_POOL_ABI,
      functionName: 'withdraw',
      args: [],
      chain: walletClient.chain,
      account,
      gasPrice,
    })
    const receipt = await waitForReceipt(publicClient, txHash)
    return {
      txHash,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed,
    }
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes(GIMO_COOLDOWN_REVERT_SELECTOR) || msg.toLowerCase().includes('cooldown')) {
      // Best-effort ETA: if we can find the most recent Unstaked event, derive seconds
      const eta = await estimateCooldownEta({
        publicClient,
        network,
        agentEoa: account.address,
      })
      throw new CooldownNotElapsedError(eta)
    }
    if (msg.includes(GIMO_MIN_STAKE_REVERT_SELECTOR)) {
      throw new Error('Gimo rejected the call (stake-floor selector). Nothing to claim?')
    }
    throw e
  }
}

export async function getStogRate(opts: {
  publicClient: PublicClient
  network: '0g-mainnet'
}): Promise<bigint> {
  const a = gimo(opts.network)
  return (await opts.publicClient.readContract({
    address: a.stog as Address,
    abi: STOG_ABI,
    functionName: 'getRate',
  })) as bigint
}

export async function getStogBalance(opts: {
  publicClient: PublicClient
  network: '0g-mainnet'
  address: Address
}): Promise<bigint> {
  const a = gimo(opts.network)
  return (await opts.publicClient.readContract({
    address: a.stog as Address,
    abi: STOG_ABI,
    functionName: 'balanceOf',
    args: [opts.address],
  })) as bigint
}

// keccak256("Unstake(address,address,uint256,uint256,uint256)") — verified
// against Gimo pool log on May 1 2026 (block 32006889 tx 0x77418ae4...). Note
// the actual event uses spelling "Unstake" not "Unstaked" and includes the
// queue-id/withdrawal-receiver fields not declared in the partial ABI. We pin
// the topic by hash so the partial ABI mismatch doesn't matter for filtering.
const UNSTAKE_TOPIC0 = '0xfe7007b2e89d80edda76299251df08366480cac22e5e260f5e662e850b1f7a32'

/**
 * Best-effort ETA estimation from the most recent Unstaked event for `agentEoa`.
 * Returns seconds until estimated claimable time. Returns 0 if cooldown
 * appears to have elapsed (the actual revert SHOULD then have been a different
 * cause — e.g. nothing queued).
 */
export async function estimateCooldownEta(opts: {
  publicClient: PublicClient
  network: '0g-mainnet'
  agentEoa: Address
  fromBlock?: bigint
}): Promise<number> {
  const { publicClient, network, agentEoa, fromBlock } = opts
  const a = gimo(network)
  const head = await publicClient.getBlockNumber()
  const start = fromBlock ?? head - LOG_SCAN_CHUNK_BLOCKS * BigInt(LOG_SCAN_MAX_CHUNKS)
  const padded = pad(agentEoa, { size: 32 })
  let cursor = start > 0n ? start : 0n
  let lastTs = 0
  let chunks = 0
  while (cursor <= head && chunks < LOG_SCAN_MAX_CHUNKS) {
    const chunkEnd = cursor + LOG_SCAN_CHUNK_BLOCKS - 1n
    const end = chunkEnd > head ? head : chunkEnd
    try {
      const logs = await rawGetLogs({
        client: publicClient,
        address: a.pool as Address,
        topics: [UNSTAKE_TOPIC0, padded],
        fromBlock: cursor,
        toBlock: end,
      })
      if (logs.length > 0) {
        const last = logs[logs.length - 1]!
        const block = await publicClient.getBlock({ blockNumber: BigInt(last.blockNumber) })
        lastTs = Math.max(lastTs, Number(block.timestamp))
      }
    } catch {
      // ignore
    }
    cursor = end + 1n
    chunks += 1
  }
  if (lastTs === 0) return Number(GIMO_COOLDOWN_SECS) // unknown; assume full cooldown
  const now = Math.floor(Date.now() / 1000)
  const elapsed = now - lastTs
  const remaining = Number(GIMO_COOLDOWN_SECS) - elapsed
  return Math.max(0, remaining)
}

/** Look up the latest Unstaked event for the agent (queue introspection). */
export async function findLatestUnstake(opts: {
  publicClient: PublicClient
  network: '0g-mainnet'
  agentEoa: Address
  mintBlock: bigint
}): Promise<{
  txHash: `0x${string}`
  blockNumber: number
  queuedAt: number
  amountStog: bigint
  amount0g: bigint
} | null> {
  const { publicClient, network, agentEoa, mintBlock } = opts
  const a = gimo(network)
  const head = await publicClient.getBlockNumber()
  const padded = pad(agentEoa, { size: 32 })
  let cursor = mintBlock
  let chunks = 0
  let latest: {
    txHash: `0x${string}`
    blockNumber: bigint
    args: { stogBurned?: bigint; amount0g?: bigint }
  } | null = null
  while (cursor <= head && chunks < LOG_SCAN_MAX_CHUNKS) {
    const chunkEnd = cursor + LOG_SCAN_CHUNK_BLOCKS - 1n
    const end = chunkEnd > head ? head : chunkEnd
    try {
      const logs = await rawGetLogs({
        client: publicClient,
        address: a.pool as Address,
        topics: [UNSTAKE_TOPIC0, padded],
        fromBlock: cursor,
        toBlock: end,
      })
      // Decode Unstake(address user, address withdrawalReceiver, uint256
      // amount0g, uint256 stogBurned, uint256 queueId) — see UNSTAKE_TOPIC0
      // comment for the verified signature.
      for (const log of logs) {
        const blockNumber = BigInt(log.blockNumber)
        if (latest !== null && blockNumber <= latest.blockNumber) continue
        const data = log.data
        const amount0g = BigInt(`0x${data.slice(2 + 2 * 64, 2 + 3 * 64)}`)
        const stogBurned = BigInt(`0x${data.slice(2 + 3 * 64, 2 + 4 * 64)}`)
        latest = {
          txHash: log.transactionHash,
          blockNumber,
          args: { amount0g, stogBurned },
        }
      }
    } catch {
      // ignore
    }
    cursor = end + 1n
    chunks += 1
  }
  if (!latest) return null
  const block = await publicClient.getBlock({ blockNumber: latest.blockNumber })
  return {
    txHash: latest.txHash,
    blockNumber: Number(latest.blockNumber),
    queuedAt: Number(block.timestamp),
    amountStog: latest.args.stogBurned ?? 0n,
    amount0g: latest.args.amount0g ?? 0n,
  }
}
