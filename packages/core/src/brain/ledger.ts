import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker'
import { JsonRpcProvider, Wallet } from 'ethers'
import type { Hex } from 'viem'
import { type AnimaNetwork, NETWORK_RPC } from '../config'

/**
 * 0G Compute ledger helpers. The ledger is a prepaid settlement account for
 * inference: deposit 0G up front, sign EIP-712 vouchers per request, provider
 * settles periodically. No chain tx per inference call.
 *
 * Contract minimum deposit is 3 0G. Calls here use `ethers` because the
 * upstream broker SDK demands an ethers Signer, matching the same quarantine
 * pattern as `brain/og-compute.ts` and `storage/og.ts`.
 */

export interface OpenLedgerOpts {
  network: AnimaNetwork
  /** Agent EOA privkey that will own the ledger. */
  privkeyHex: Hex
  /** Initial deposit in 0G (floating point). Contract minimum 3. */
  initialBalance: number
  /**
   * Optional provider to `acknowledgeProviderSigner` after the ledger is open.
   * Lets a later `broker.inference.*` call work without a separate ack step.
   */
  providerAddress?: string
}

export interface LedgerStatus {
  /** True if the wallet already had a ledger before we touched it. */
  alreadyExisted: boolean
  availableBalanceBefore: bigint
  availableBalanceAfter: bigint
  totalBalanceBefore: bigint
  totalBalanceAfter: bigint
}

type Broker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>

/**
 * Cache brokers keyed on `${network}:${privkey}` so back-to-back calls (e.g.
 * `getLedgerBalance` then `depositToLedger` in `anima topup --compute`) don't
 * each pay the ~100-200ms SDK handshake cost. Cleared on process exit.
 */
const brokerCache = new Map<string, Broker>()

async function makeBroker(network: AnimaNetwork, privkeyHex: Hex): Promise<Broker> {
  const cacheKey = `${network}:${privkeyHex}`
  const hit = brokerCache.get(cacheKey)
  if (hit) return hit
  const provider = new JsonRpcProvider(NETWORK_RPC[network])
  const wallet = new Wallet(privkeyHex, provider)
  // biome-ignore lint/suspicious/noExplicitAny: SDK ethers Signer typing mismatch
  const broker = (await createZGComputeNetworkBroker(wallet as any)) as Broker
  brokerCache.set(cacheKey, broker)
  return broker
}

/**
 * Open or top up the agent's 0G Compute ledger. If no ledger exists, calls
 * `addLedger(initialBalance)`. If one exists, calls `depositFund(initialBalance)`.
 * Either way, reports the before/after balances so the caller can surface a
 * receipt to the user.
 */
export async function openComputeLedger(opts: OpenLedgerOpts): Promise<LedgerStatus> {
  const broker = await makeBroker(opts.network, opts.privkeyHex)

  let alreadyExisted = false
  let availableBalanceBefore = 0n
  let totalBalanceBefore = 0n
  try {
    const existing = await broker.ledger.getLedger()
    alreadyExisted = true
    availableBalanceBefore = existing.availableBalance ?? 0n
    totalBalanceBefore = existing.totalBalance ?? 0n
  } catch {
    // No ledger yet.
  }

  if (alreadyExisted) {
    await broker.ledger.depositFund(opts.initialBalance)
  } else {
    await broker.ledger.addLedger(opts.initialBalance)
  }

  if (opts.providerAddress) {
    try {
      await broker.inference.acknowledgeProviderSigner(opts.providerAddress)
    } catch {
      // Already acknowledged (broker throws on repeat).
    }
  }

  const after = await broker.ledger.getLedger()
  return {
    alreadyExisted,
    availableBalanceBefore,
    availableBalanceAfter: after.availableBalance ?? 0n,
    totalBalanceBefore,
    totalBalanceAfter: after.totalBalance ?? 0n,
  }
}

/** Read the current ledger balance, or null if the ledger doesn't exist. */
export async function getLedgerBalance(opts: {
  network: AnimaNetwork
  privkeyHex: Hex
}): Promise<{ availableBalance: bigint; totalBalance: bigint } | null> {
  const broker = await makeBroker(opts.network, opts.privkeyHex)
  try {
    const l = await broker.ledger.getLedger()
    return {
      availableBalance: l.availableBalance ?? 0n,
      totalBalance: l.totalBalance ?? 0n,
    }
  } catch {
    return null
  }
}

/**
 * Top up the existing ledger by `amount` 0G. Agent EOA pays gas and the
 * deposit moves from its wallet to the settlement contract. Used by
 * `anima topup --compute N`. Requires the ledger to exist; caller should
 * fall back to `openComputeLedger` if it doesn't.
 */
export async function depositToLedger(opts: {
  network: AnimaNetwork
  privkeyHex: Hex
  amount: number
}): Promise<void> {
  const broker = await makeBroker(opts.network, opts.privkeyHex)
  await broker.ledger.depositFund(opts.amount)
}
