import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker'
import { Contract, JsonRpcProvider, Wallet } from 'ethers'
import { type Address, type Hex, parseEther } from 'viem'
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

/**
 * Test hook. Pass a broker factory to bypass the real SDK + RPC. Each helper
 * still goes through `makeBroker` with the same cache key shape, so multiple
 * helper calls in a test share the injected broker.
 */
export function setBrokerFactoryForTests(
  factory: ((network: AnimaNetwork, privkeyHex: Hex) => Promise<Broker>) | null,
): void {
  brokerFactory = factory
  brokerCache.clear()
}

let brokerFactory: ((network: AnimaNetwork, privkeyHex: Hex) => Promise<Broker>) | null = null

async function makeBroker(network: AnimaNetwork, privkeyHex: Hex): Promise<Broker> {
  const cacheKey = `${network}:${privkeyHex}`
  const hit = brokerCache.get(cacheKey)
  if (hit) return hit
  const broker = brokerFactory
    ? await brokerFactory(network, privkeyHex)
    : await defaultBrokerFactory(network, privkeyHex)
  brokerCache.set(cacheKey, broker)
  return broker
}

async function defaultBrokerFactory(network: AnimaNetwork, privkeyHex: Hex): Promise<Broker> {
  const provider = new JsonRpcProvider(NETWORK_RPC[network])
  const wallet = new Wallet(privkeyHex, provider)
  // biome-ignore lint/suspicious/noExplicitAny: SDK ethers Signer typing mismatch
  return createZGComputeNetworkBroker(wallet as any)
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

/**
 * Transfer `amount` 0G from the agent's main ledger (already opened + funded
 * via depositToLedger) into a specific provider sub-account. The 0G Compute
 * SDK requires per-provider sub-accounts; the init wizard only seeds the
 * inference provider, so vision.analyze fails on fresh agents with
 * "Sub-account not found" until a separate transfer lands.
 *
 * `serviceType` is `'inference'` because the SDK uses one bucket for all
 * provider envelopes regardless of which model sits behind them.
 */
export async function transferFundToProvider(opts: {
  network: AnimaNetwork
  privkeyHex: Hex
  /** 0x address of the provider whose sub-account to seed. */
  provider: Address
  /** Amount in 0G (floating point), converted to wei internally. */
  amount: number
}): Promise<void> {
  const broker = await makeBroker(opts.network, opts.privkeyHex)
  const amountWei = parseEther(opts.amount.toString() as `${number}`)
  await broker.ledger.transferFund(opts.provider, 'inference', amountWei)
}

export interface ProviderSubAccount {
  provider: string
  balance: bigint
  pendingRefund: bigint
}

/**
 * Read the ledger plus per-provider sub-account detail. Each tuple from the
 * SDK is `[providerAddress, balance, pendingRefund]` in neuron units. `balance`
 * minus `pendingRefund` is what's still pulling from the main ledger; the rest
 * is queued to return on the next successful retrieveFund call.
 */
export async function getLedgerDetail(opts: {
  network: AnimaNetwork
  privkeyHex: Hex
}): Promise<{
  availableBalance: bigint
  totalBalance: bigint
  inferenceProviders: ProviderSubAccount[]
} | null> {
  const broker = await makeBroker(opts.network, opts.privkeyHex)
  // Independent reads — ledger row + provider sub-accounts. Run in parallel and
  // tolerate the providers call failing (no providers acked yet on a fresh ledger).
  const [ledgerRes, providersRes] = await Promise.allSettled([
    broker.ledger.getLedger(),
    broker.ledger.getProvidersWithBalance('inference'),
  ])
  if (ledgerRes.status === 'rejected') return null
  const availableBalance = ledgerRes.value.availableBalance ?? 0n
  const totalBalance = ledgerRes.value.totalBalance ?? 0n
  const providers = providersRes.status === 'fulfilled' ? providersRes.value : []
  const inferenceProviders = providers.map(([provider, balance, pendingRefund]) => ({
    provider,
    balance,
    pendingRefund,
  }))
  return { availableBalance, totalBalance, inferenceProviders }
}

/**
 * Withdraw `amount` 0G from the main ledger account back to the agent EOA.
 * Caller is responsible for ensuring the funds aren't locked inside provider
 * sub-accounts (see retrieveLedgerFunds).
 */
export async function refundFromLedger(opts: {
  network: AnimaNetwork
  privkeyHex: Hex
  amount: number
}): Promise<void> {
  const broker = await makeBroker(opts.network, opts.privkeyHex)
  await broker.ledger.refund(opts.amount)
}

/**
 * Pull funds from inference provider sub-accounts back into the main ledger.
 * Subject to the contract's lock period; calling once initiates the refund
 * window, calling a second time after the window expires actually moves the
 * funds. The SDK returns no value on success.
 */
export async function retrieveLedgerFunds(opts: {
  network: AnimaNetwork
  privkeyHex: Hex
}): Promise<void> {
  const broker = await makeBroker(opts.network, opts.privkeyHex)
  await broker.ledger.retrieveFund('inference')
}

/**
 * Close the ledger entirely. Refunds the remaining main-account balance to
 * the agent EOA and removes the ledger record. Funds locked inside provider
 * sub-accounts must be retrieved via retrieveLedgerFunds before deletion.
 */
export async function closeLedger(opts: {
  network: AnimaNetwork
  privkeyHex: Hex
}): Promise<void> {
  const broker = await makeBroker(opts.network, opts.privkeyHex)
  await broker.ledger.deleteLedger()
}

/**
 * 0G Compute LedgerManager contract addresses, mirrored from the upstream
 * `@0glabs/0g-serving-broker` constants module so we can read ledger state
 * without instantiating a full broker (no signer, no SDK init cost).
 *
 * Verified Apr 7 2026 against the SDK typechain factory — struct order is
 * (address user, uint256 availableBalance, uint256 totalBalance, string
 * additionalInfo). Do NOT swap the order of the first two uint256 fields;
 * the names are NOT alphabetical, they're declaration order.
 */
const LEDGER_MANAGER_ADDRESS: Record<AnimaNetwork, Address> = {
  '0g-mainnet': '0x2dE54c845Cd948B72D2e32e39586fe89607074E3',
  '0g-testnet': '0xE70830508dAc0A97e6c087c75f402f9Be669E406',
}

const LEDGER_READ_ABI = [
  'function getLedger(address user) view returns (tuple(address user, uint256 availableBalance, uint256 totalBalance, string additionalInfo))',
] as const

export interface LedgerReadResult {
  /** Total deposit pool (lifetime sum of addLedger + depositFund). */
  totalBalance: bigint
  /** Unallocated, free for transferFund into provider sub-accounts. */
  availableBalance: bigint
  /** Sum allocated to provider sub-accounts (totalBalance - availableBalance). */
  lockedBalance: bigint
}

/**
 * Read an agent's compute ledger row WITHOUT a private key. Spins a viem-free
 * ethers JsonRpcProvider, calls the LedgerManager contract directly. Returns
 * null if the ledger doesn't exist for that address (revert is silent).
 *
 * For per-provider envelope detail, the caller still needs an unlocked agent
 * signer (SDK's `getProvidersWithBalance` requires it). Use
 * `getLedgerDetail({ privkeyHex })` when unlock is acceptable; use
 * `getLedgerDetailReadOnly({ agentAddress })` for operator-side aggregators
 * like `anima balance` that want a fast read with no friction.
 */
export async function getLedgerDetailReadOnly(opts: {
  network: AnimaNetwork
  agentAddress: Address
  rpcUrl?: string
}): Promise<LedgerReadResult | null> {
  const provider = new JsonRpcProvider(opts.rpcUrl ?? NETWORK_RPC[opts.network])
  const contract = new Contract(LEDGER_MANAGER_ADDRESS[opts.network], LEDGER_READ_ABI, provider)
  try {
    // biome-ignore lint/suspicious/noExplicitAny: ethers ABI returns dynamically-typed Result
    const getLedgerFn = (contract as any).getLedger as (a: Address) => Promise<{
      totalBalance: bigint
      availableBalance: bigint
    }>
    const r = await getLedgerFn(opts.agentAddress)
    const totalBalance = r.totalBalance
    const availableBalance = r.availableBalance
    return {
      totalBalance,
      availableBalance,
      lockedBalance: totalBalance - availableBalance,
    }
  } catch {
    return null
  }
}
